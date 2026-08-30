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
const PUBLISHED_ACTIVITY_TOOL = "math_scratch_recent_activity";
const WORKSPACE_ACTIVITY_TOOL = "math_scratch_recent_workspace_activity";
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

function parseWorkspaceActivity(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`math_scratch_recent_workspace_activity returned invalid JSON: ${error.message}`);
  }
  const feed = envelope?.structuredContent;
  if (!feed || !Array.isArray(feed.items) || !Number.isInteger(feed.total) || typeof feed.truncated !== "boolean") {
    throw new Error("math_scratch_recent_workspace_activity returned no structured workspace feed");
  }
  const items = feed.items.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Workspace activity item ${index} is not an object`);
    return {
      ...item,
      latest_at: parseTimestamp(item.latest_at, `Workspace activity item ${index} timestamp`),
    };
  });
  items.sort((left, right) => right.latest_at.localeCompare(left.latest_at) || String(right.workspace_id).localeCompare(String(left.workspace_id)));
  return { items, total: feed.total, truncated: feed.truncated };
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

function formatWorkspaceEntry(item) {
  const at = item.latest_at.slice(0, 16).replace("T", " ") + "Z";
  const title = truncateUtf8(item.workspace_title, 110);
  const target = truncateUtf8(item.formulation_title || item.problem_title, 110);
  const changes = [
    item.created_in_window ? "created" : "",
    item.guide_updated_at ? "guide updated" : "",
    item.note_count ? `${item.note_count} note${item.note_count === 1 ? "" : "s"}` : "",
    item.changed_file_count ? `${item.changed_file_count} changed path${item.changed_file_count === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");
  const note = item.latest_note_excerpt
    ? ` Latest note by ${truncateUtf8(item.latest_note_author_name, 45)}: ${truncateUtf8(item.latest_note_excerpt, 145)}`
    : "";
  const paths = item.latest_file_paths?.length
    ? ` Paths: ${truncateUtf8(item.latest_file_paths.join(", "), 100)}`
    : "";
  return truncateUtf8(`- ${at} workspace ${title} on ${target}: ${changes}.${note}${paths} (${item.workspace_id})`, 430);
}

function formatActivity(published, workspaces, since, invokedAt, incomplete) {
  const publishedCounts = Object.entries(
    published.reduce((accumulator, item) => {
      accumulator[item.kind] = (accumulator[item.kind] ?? 0) + 1;
      return accumulator;
    }, {}),
  ).map(([kind, count]) => `${KIND_LABELS[kind]} ${count}`).join(", ");
  const noteCount = workspaces.reduce((sum, item) => sum + item.note_count, 0);
  const fileCount = workspaces.reduce((sum, item) => sum + item.changed_file_count, 0);
  const guideCount = workspaces.filter((item) => item.guide_updated_at).length;
  const createdCount = workspaces.filter((item) => item.created_in_window).length;

  const lines = [
    incomplete
      ? `Partial scratch activity after ${since}. A feed limit was reached, so the checkpoint was not advanced.`
      : `Scratch activity after ${since} through ${invokedAt}.`,
    `Working activity: ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}, ${noteCount} notes, ${fileCount} changed file paths, ${guideCount} guide updates, ${createdCount} new workspaces.`,
    `Published advancement: ${published.length} event${published.length === 1 ? "" : "s"}${publishedCounts ? ` (${publishedCounts})` : ""}.`,
  ];
  if (published.length === 0 && workspaces.length === 0) {
    lines.push("Nothing changed in the scratch server during this window.");
    return lines.join("\n");
  }
  if (published.length > 0) lines.push("", "Published:", ...published.map(formatEntry));
  if (workspaces.length > 0) lines.push("", "Workspaces:", ...workspaces.map(formatWorkspaceEntry));
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
    const options = { signal, timeout: 10_000 };
    const [publishedResult, workspaceResult] = await Promise.all([
      exec("mcp", ["call", PUBLISHED_ACTIVITY_TOOL, JSON.stringify({ limit: ACTIVITY_LIMIT })], options),
      exec("mcp", ["call", WORKSPACE_ACTIVITY_TOOL, JSON.stringify({
        after: since,
        before: invokedAt,
        limit: ACTIVITY_LIMIT,
      })], options),
    ]);
    for (const [name, result] of [
      [PUBLISHED_ACTIVITY_TOOL, publishedResult],
      [WORKSPACE_ACTIVITY_TOOL, workspaceResult],
    ]) {
      if (result.code === 0) continue;
      const diagnostic = truncateUtf8(result.stderr || result.stdout || `exit ${result.code}`, 1000);
      throw new Error(`Could not call ${name}: ${diagnostic}`);
    }
    const publishedFeed = parseActivity(publishedResult.stdout);
    const oldest = publishedFeed.at(-1)?.at;
    const publishedIncomplete = publishedFeed.length === ACTIVITY_LIMIT && oldest > since;
    const published = publishedFeed.filter((item) => item.at > since && item.at <= invokedAt);
    const workspaceFeed = parseWorkspaceActivity(workspaceResult.stdout);
    const incomplete = publishedIncomplete || workspaceFeed.truncated;
    if (!incomplete) await writeCheckpoint(statePath, invokedAt);
    return {
      text: formatActivity(published, workspaceFeed.items, since, invokedAt, incomplete),
      details: {
        since,
        invokedAt,
        incomplete,
        publishedCount: published.length,
        workspaceCount: workspaceFeed.items.length,
        published,
        workspaces: workspaceFeed.items,
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
    description: "Read everything new on the math_scratch MCP server since this machine-wide tool was last invoked. The first invocation looks back one hour. Reports workspace creation, guide edits, notes, and changed file paths alongside published problems, formulations, settlements, solutions, reviews, reductions, and links.",
    promptSnippet: "Read math scratch work and publications since the previous invocation",
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
