import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { Type } from "typebox";

export const ACTIVITY_LIMIT = 100;
export const FIRST_LOOKBACK_MS = 60 * 60 * 1000;
export const TOOL_NAME = "scratch_updates";

const STATE_VERSION = 1;
const MCP_TOOL = "math_scratch_recent_activity";
const KIND_LABELS = {
  problem_published: "problem published",
  formulation_published: "formulation published",
  formulation_settled: "formulation settled",
  solution_submitted: "solution submitted",
  solution_reviewed: "solution reviewed",
  reduction_published: "reduction published",
  formulation_linked: "formulation linked",
};

function defaultStatePath(environment = process.env) {
  const stateRoot = environment.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return environment.PI_SCRATCH_UPDATES_STATE || join(stateRoot, "pi-runtime", "scratch-updates.json");
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is not a valid ISO timestamp`);
  }
  return new Date(value).toISOString();
}

async function readCheckpoint(statePath, invokedAtMs) {
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Date(invokedAtMs - FIRST_LOOKBACK_MS).toISOString();
    throw error;
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Scratch update state is not valid JSON at ${statePath}: ${error.message}`);
  }
  if (state?.version !== STATE_VERSION) {
    throw new Error(`Scratch update state at ${statePath} has unsupported version ${state?.version}`);
  }
  const checkpoint = parseTimestamp(state.lastInvokedAt, "Scratch update checkpoint");
  if (Date.parse(checkpoint) > invokedAtMs) {
    throw new Error(`Scratch update checkpoint ${checkpoint} is later than this invocation`);
  }
  return checkpoint;
}

async function writeCheckpoint(statePath, invokedAt) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: STATE_VERSION, lastInvokedAt: invokedAt }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, statePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Scratch update invocation was cancelled"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Scratch update invocation was cancelled"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function acquireLock(statePath, signal) {
  const lockPath = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
      } catch (ownerError) {
        if (ownerError?.code === "ENOENT") {
          await wait(25, signal);
          continue;
        }
        throw new Error(`Scratch update lock is corrupt at ${lockPath}: ${ownerError.message}`);
      }
      if (!processExists(owner.pid)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await wait(25, signal);
    }
  }
  throw new Error("Another scratch_updates invocation still holds the machine-wide checkpoint");
}

function parseActivity(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`math_scratch_recent_activity returned invalid JSON: ${error.message}`);
  }
  const feed = envelope?.structuredContent;
  if (!feed || !Array.isArray(feed.items)) {
    throw new Error("math_scratch_recent_activity returned no structured activity feed");
  }
  const items = feed.items.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Activity item ${index} is not an object`);
    if (!(item.kind in KIND_LABELS)) throw new Error(`Activity item ${index} has unknown kind ${item.kind}`);
    return { ...item, at: parseTimestamp(item.at, `Activity item ${index} timestamp`) };
  });
  items.sort((left, right) => right.at.localeCompare(left.at) || String(right.object_id).localeCompare(String(left.object_id)));
  return items;
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function truncateUtf8(value, maxBytes) {
  const text = oneLine(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let output = "";
  for (const character of text) {
    if (Buffer.byteLength(`${output}${character}…`) > maxBytes) break;
    output += character;
  }
  return `${output}…`;
}

function formatEntry(item) {
  const at = item.at.slice(0, 16).replace("T", " ") + "Z";
  const title = truncateUtf8(item.formulation_title || item.problem_title || item.object_id, 150);
  const detail = truncateUtf8(item.detail, 160);
  const actor = truncateUtf8(item.actor_name, 60);
  const facts = [item.outcome, item.source].map(oneLine).filter(Boolean).join(", ");
  const description = detail && detail !== title ? `: ${detail}` : "";
  const qualifiers = facts ? ` [${facts}]` : "";
  return truncateUtf8(
    `- ${at} ${KIND_LABELS[item.kind]}: ${title}${qualifiers}${description} — ${actor} (${item.object_id})`,
    430,
  );
}

function formatActivity(items, since, invokedAt, incomplete) {
  const counts = Object.entries(
    items.reduce((accumulator, item) => {
      accumulator[item.kind] = (accumulator[item.kind] ?? 0) + 1;
      return accumulator;
    }, {}),
  ).map(([kind, count]) => `${KIND_LABELS[kind]} ${count}`).join(", ");

  const lines = [
    incomplete
      ? `Partial scratch activity after ${since}. The feed's ${ACTIVITY_LIMIT}-entry window did not reach the previous checkpoint, so the checkpoint was not advanced.`
      : `Scratch activity after ${since} through ${invokedAt}: ${items.length} event${items.length === 1 ? "" : "s"}.`,
  ];
  if (items.length === 0) {
    lines.push("Nothing new was published.");
    return lines.join("\n");
  }
  lines.push(`Summary: ${counts}.`, "", ...items.map(formatEntry));
  return lines.join("\n");
}

export async function runScratchUpdates({
  exec,
  statePath = defaultStatePath(),
  now = () => Date.now(),
  signal,
}) {
  const release = await acquireLock(statePath, signal);
  try {
    const invokedAtMs = now();
    const invokedAt = new Date(invokedAtMs).toISOString();
    const since = await readCheckpoint(statePath, invokedAtMs);
    const result = await exec(
      "mcp",
      ["call", MCP_TOOL, JSON.stringify({ limit: ACTIVITY_LIMIT })],
      { signal, timeout: 10_000 },
    );
    if (result.code !== 0) {
      const diagnostic = truncateUtf8(result.stderr || result.stdout || `exit ${result.code}`, 1000);
      throw new Error(`Could not read the math scratch activity feed: ${diagnostic}`);
    }
    const feed = parseActivity(result.stdout);
    const oldest = feed.at(-1)?.at;
    const incomplete = feed.length === ACTIVITY_LIMIT && oldest > since;
    const items = feed.filter((item) => item.at > since && item.at <= invokedAt);
    if (!incomplete) await writeCheckpoint(statePath, invokedAt);
    return {
      text: formatActivity(items, since, invokedAt, incomplete),
      details: {
        since,
        invokedAt,
        incomplete,
        count: items.length,
        items,
        statePath,
      },
    };
  } finally {
    await release();
  }
}

export function registerScratchUpdates(pi, options = {}) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Scratch Updates",
    description: "Read published advancement from the math_scratch MCP server since this machine-wide tool was last invoked. The first invocation looks back one hour. Returns problem and formulation publications, settlements, solutions, reviews, reductions, and formulation links. Workspace notes and files are not part of the published activity feed.",
    promptSnippet: "Read published math scratch activity since the previous invocation",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal) {
      const result = await runScratchUpdates({
        exec: (command, args, execOptions) => pi.exec(command, args, execOptions),
        statePath: options.statePath,
        now: options.now,
        signal,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });
}

export default function (pi) {
  registerScratchUpdates(pi);
}
