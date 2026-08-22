import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The line between "large" and "this tool has an unbounded field". Only the
 * second belongs in an inbox reserved for things that must be fixed, and the
 * measured ceiling of healthy traffic on this host is what sets it: the math
 * ledger's `news` answers with 96 KB, a full reviewer worklist with 86 KB, the
 * largest entry in the corpus with 86 KB, and a 500-row SQL read — the
 * documented row cap — with 644 KB. The incident that prompted this extension
 * was 13.5 MB. A megabyte leaves healthy traffic room to grow and still catches
 * the condition by an order of magnitude. README.md carries the measurements.
 */
export const DEFAULT_THRESHOLD_KB = 1024;

export const KEY_PREFIX = "mcp-oversize";

const DEFAULT_INBOX = "/var/lib/machine-alerts/inbox";

// Deliberately blunt: `key` catches `contributor_key` and everything like it,
// and over-redacting a field name in an alert body costs nothing next to
// writing a credential into a durable file that outlives the session.
const SECRETISH = /(token|secret|password|passwd|key|authorization|cookie|credential)/i;

const ARGUMENT_LIMIT = 500;

export function thresholdBytes(env = process.env) {
  const kb = Number(env.PI_MCP_SIZE_ALERT_KB);
  return Math.floor((Number.isFinite(kb) && kb > 0 ? kb : DEFAULT_THRESHOLD_KB) * 1024);
}

const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * What one MCP call returned, from the sizes pi's own output guard already
 * measured: `outputGuard.originalBytes` is the text before truncation and
 * `mcpResult.rawResultBytes` is the raw JSON-RPC result before it was
 * summarized. Whichever is present, the larger one is what crossed the wire.
 *
 * `details.server` is what makes a result attributable to a server and a tool.
 * An mcpScript result carries no server (it is a batch of calls, and the guard
 * measured what the script chose to emit), so it is not an oversized response
 * from anyone and is deliberately not measured here.
 */
export function measureMcpResponse(details) {
  if (details === null || typeof details !== "object") return null;
  if (typeof details.server !== "string" || details.server === "") return null;
  const bytes = Math.max(positive(details.outputGuard?.originalBytes), positive(details.mcpResult?.rawResultBytes));
  if (bytes === 0) return null;
  const tool =
    typeof details.tool === "string" && details.tool !== ""
      ? details.tool
      : typeof details.resourceUri === "string" && details.resourceUri !== ""
        ? details.resourceUri
        : "(unnamed)";
  const spill = details.mcpResult?.fullResultPath ?? details.outputGuard?.fullOutputPath ?? null;
  return {
    server: details.server,
    tool,
    bytes,
    key: `${KEY_PREFIX} ${details.server}/${tool}`,
    spill: typeof spill === "string" ? spill : null,
  };
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function redactArguments(input) {
  if (input === null || typeof input !== "object") return "(none)";
  let text;
  try {
    text = JSON.stringify(input, (key, value) => (SECRETISH.test(key) ? "[redacted]" : value));
  } catch {
    return "(unserializable)";
  }
  if (text === undefined) return "(none)";
  return text.length > ARGUMENT_LIMIT ? `${text.slice(0, ARGUMENT_LIMIT)}…` : text;
}

export const alertTitle = (measured, limit) =>
  `MCP response over ${formatSize(limit)}: ${measured.server}/${measured.tool} returned ${formatSize(measured.bytes)}`;

export function alertBody(measured, { input, cwd, limit } = {}) {
  return [
    `- key: ${measured.key}`,
    `- server: ${measured.server}`,
    `- tool: ${measured.tool}`,
    `- response: ${formatSize(measured.bytes)} (alerts above ${formatSize(limit ?? 0)})`,
    `- arguments: ${redactArguments(input)}`,
    measured.spill
      ? `- the whole response: ${measured.spill} (pi saved it; /tmp does not survive a reboot)`
      : "- the whole response was not saved to disk",
    `- seen by: a pi session in ${cwd ?? "an unknown directory"}`,
    "",
    "Read the arguments above first. A response whose size the caller asked for — a bulk SQL read, a",
    "deliberate dump of whole documents — is the caller's own doing, nothing needs fixing, and this",
    "file can go. The case worth your time is the other one: a small request that came back enormous.",
    "",
    "That means the tool has an unbounded field in what it returns. Nothing was corrupted — pi's",
    "output guard cut the response before the model read it — so the damage is bandwidth, latency,",
    "and a read surface that cannot be used the way it is meant to be. The last one was a reviewer",
    "worklist where twenty rows each carried a full compiler log, and it answered a one-row question",
    "with 13 MB.",
    "",
    "Fixed means the tool's own read surface bounds the field, so the answer is small at the source",
    "rather than truncated on the way past. The saved response above is the whole of the evidence:",
    "the offending field is usually obvious from the byte counts of its top-level keys.",
    "",
    "If a size like this is simply normal for this tool, say so here and raise PI_MCP_SIZE_ALERT_KB",
    "rather than deleting the same alert every week.",
    "",
    "While this file sits in the inbox, further oversized responses from this same tool file nothing.",
    "Deleting it re-arms the alert, which is what makes deletion mean \"looked at\".",
  ].join("\n");
}

export const inboxPath = (env = process.env) => env.MACHINE_ALERTS_INBOX ?? DEFAULT_INBOX;

/** True when an unconsumed alert for the same tool is already waiting. */
export function alreadyPending(files, key) {
  return files.some((file) => file.includes(key));
}

function readInbox(env) {
  try {
    const dir = inboxPath(env);
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        try {
          return readFileSync(join(dir, name), "utf8");
        } catch {
          return "";
        }
      });
  } catch {
    return [];
  }
}

/**
 * The `alert` CLI owns the inbox file format and its umask; a second writer here
 * would be a second format that drifts. It is a global command, so this works
 * for every identity that runs a pi session.
 */
function fileAlert(title, body, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("alert", [title, body], {
        env: { ...env, ALERT_SOURCE: "mcp-size-guard" },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 10_000,
      });
    } catch (error) {
      console.error(`mcp-size-guard: could not run alert: ${error?.message ?? error}`);
      resolve(false);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      console.error(`mcp-size-guard: could not run alert: ${error?.message ?? error}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0) console.error(`mcp-size-guard: alert exited ${code}: ${stderr.trim()}`);
      resolve(code === 0);
    });
  });
}

export function registerGuard(pi, env = process.env, deps = {}) {
  if (env.PI_MCP_SIZE_GUARD === "off") return;
  const limit = thresholdBytes(env);
  const pending = deps.readInbox ?? (() => readInbox(env));
  const file = deps.fileAlert ?? ((title, body) => fileAlert(title, body, env));

  pi.on("tool_result", async (event, ctx) => {
    // A guard on the tool-result path must never be the reason a tool result
    // fails to arrive, whatever is wrong with the inbox or the CLI.
    try {
      const measured = measureMcpResponse(event?.details);
      if (measured === null || measured.bytes < limit) return undefined;
      if (alreadyPending(pending(), measured.key)) return undefined;
      await file(alertTitle(measured, limit), alertBody(measured, { input: event.input, cwd: ctx?.cwd, limit }));
    } catch (error) {
      console.error(`mcp-size-guard: ${error?.message ?? error}`);
    }
    return undefined;
  });
}

export default function (pi) {
  registerGuard(pi);
}
