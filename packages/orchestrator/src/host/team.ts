import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { TeamLaunch } from "./types.js";

interface ChangedFile {
  readonly path: string;
  readonly modifiedAt: number;
}

const MAX_VISIBLE_CHANGES = 120;
const FIND_TIMEOUT_MS = 5_000;
const CONDENSE_TIMEOUT_MS = 60_000;
const WRITE_LOCK_MAX_AGE_MS = 60_000;
const WRITE_LOCK_ROOT = join(tmpdir(), "pi-orchestrator-team-writes");

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function runFile(command: string, args: readonly string[], options: { timeout: number; maxBuffer: number }): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(command, [...args], { timeout: options.timeout, maxBuffer: options.maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${String(error)}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`));
        return;
      }
      resolveOutput(stdout);
    });
  });
}

async function removeWriteLock(lock: string): Promise<void> {
  try {
    await unlink(lock);
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code !== "ENOENT") throw thrown;
  }
}

async function acquireWriteLock(workspace: string, path: string): Promise<string | undefined> {
  await mkdir(WRITE_LOCK_ROOT, { recursive: true });
  const key = createHash("sha256").update(`${workspace}\0${path}`).digest("hex");
  const lock = join(WRITE_LOCK_ROOT, key);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      return lock;
    } catch (thrown) {
      if ((thrown as NodeJS.ErrnoException).code !== "EEXIST") throw thrown;
      const age = Date.now() - (await stat(lock)).mtimeMs;
      if (age <= WRITE_LOCK_MAX_AGE_MS || attempt > 0) return undefined;
      await removeWriteLock(lock);
    }
  }
  return undefined;
}

async function changedSince(root: string, since: number): Promise<ChangedFile[]> {
  const output = await runFile(
    "find",
    [root, "-type", "f", "-newermt", `@${since / 1000}`, "-printf", "%T@\\t%p\\0"],
    { timeout: FIND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const tab = record.indexOf("\t");
      if (tab < 0) return [];
      const modifiedAt = Number(record.slice(0, tab)) * 1000;
      const path = record.slice(tab + 1);
      return Number.isFinite(modifiedAt) ? [{ path, modifiedAt }] : [];
    })
    .sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));
}

/**
 * A team worker cannot coordinate from a launch-time directory listing. This
 * session-local extension tracks the worker's last successful edit and the
 * exact versions it has read since then. Every provider call receives the
 * outstanding shared changes, and edit/write is refused until those versions
 * have been read. The filesystem remains the authority, so process restarts
 * lose no shared state.
 */
export function teamWorkspaceExtension(root: string, role: TeamLaunch["role"]): (pi: any) => void {
  const workspace = resolve(root);
  const startedAt = Date.now();
  let lastEditAt = startedAt;
  let editStartedAt: number | undefined;
  let writeLock: string | undefined;
  const readAt = new Map<string, number>();

  const pending = async (): Promise<ChangedFile[]> => {
    const changed = await changedSince(workspace, lastEditAt);
    return changed.filter((file) => (readAt.get(file.path) ?? 0) < file.modifiedAt);
  };

  return (pi: any): void => {
    pi.on("tool_execution_end", async (event: any) => {
      if (writeLock !== undefined) {
        await removeWriteLock(writeLock);
        writeLock = undefined;
      }
      if (event.isError) {
        if (event.toolName === "edit" || event.toolName === "write") editStartedAt = undefined;
        return;
      }
      const rawPath = event.args?.path;
      if (typeof rawPath !== "string") return;
      const path = resolve(workspace, rawPath);
      if (!inside(workspace, path)) return;
      if (event.toolName === "read") {
        try {
          readAt.set(path, (await stat(path)).mtimeMs);
        } catch {
          return;
        }
      } else if (event.toolName === "edit" || event.toolName === "write") {
        // Start the next change window before this write ran, not after it.
        // A teammate may have landed a different file while the tool was in
        // flight. Mark only our own resulting file as seen so that concurrent
        // teammate work remains visible on the next call.
        lastEditAt = editStartedAt ?? Date.now();
        editStartedAt = undefined;
        readAt.clear();
        try {
          readAt.set(path, (await stat(path)).mtimeMs);
        } catch {
          return;
        }
      }
    });

    if (role === "worker") {
      pi.on("tool_call", async (event: any) => {
        if (event.toolName !== "edit" && event.toolName !== "write") return;
        const rawPath = event.input?.path;
        if (typeof rawPath !== "string") return;
        const path = resolve(workspace, rawPath);
        if (!inside(workspace, path)) return;
        const lock = await acquireWriteLock(workspace, path);
        if (lock === undefined) {
          return {
            block: true,
            reason: "A teammate is writing this shared file right now. Read its current version and try again after that write finishes.",
          };
        }
        writeLock = lock;
        const writeWindowStartedAt = Date.now();
        let unseen: ChangedFile[];
        try {
          unseen = await pending();
        } catch (thrown) {
          await removeWriteLock(lock);
          writeLock = undefined;
          throw thrown;
        }
        if (unseen.length === 0) {
          editStartedAt = writeWindowStartedAt;
          return;
        }
        await removeWriteLock(lock);
        writeLock = undefined;
        const paths = unseen.slice(0, MAX_VISIBLE_CHANGES).map((file) => `- ${relative(workspace, file.path)}`);
        const omitted = unseen.length - paths.length;
        return {
          block: true,
          reason: [
            "Your teammates changed shared files since your last edit. Read each current version before writing so you do not overwrite work you have not seen:",
            ...paths,
            ...(omitted > 0 ? [`- ...and ${omitted} more`] : []),
          ].join("\n"),
        };
      });
    }

    pi.on("context", async (event: any) => {
      const unseen = await pending();
      if (unseen.length === 0) return;
      const paths = unseen.slice(0, MAX_VISIBLE_CHANGES).map((file) => `- ${relative(workspace, file.path)}`);
      const omitted = unseen.length - paths.length;
      const update = {
        role: "user",
        customType: "team-workspace-updates",
        content: [{
          type: "text",
          text: [
            "# Shared workspace updates",
            "This is live team context, not a new user request. These files changed after your last successful edit and you have not read their current versions:",
            ...paths,
            ...(omitted > 0 ? [`- ...and ${omitted} more`] : []),
            role === "worker"
              ? "Read them before your next edit or write. The host enforces this so concurrent work is not silently overwritten."
              : "Use these changes when updating your programme-level view of the team.",
          ].join("\n"),
        }],
        timestamp: Date.now(),
      };
      const messages = event.messages.filter((message: any) => message?.customType !== "team-workspace-updates");
      const retainedSkills = messages.findIndex((message: any) => message?.customType === "state-compactor-skills");
      messages.splice(retainedSkills < 0 ? 0 : retainedSkills + 1, 0, update);
      return { messages };
    });
  };
}

export function teamSystemPrompt(team: TeamLaunch, workspace: string): string {
  if (team.role === "worker") {
    return [
      "# Team worker",
      `You are worker ${team.slot} in a team of ${team.workers} full mathematical colleagues sharing ${workspace}.`,
      "Work directly on the programme and leave proofs, counterexamples, certificates, code, and honest obstructions in the shared area. Parallel derivations are welcome. Nobody owns a route merely by trying it first.",
      "The host reports files your teammates changed after your last edit and refuses edit/write until you have read those current versions. Treat that as collaboration context, not an instruction to abandon your own line.",
      "A supervisor reads compacted views of all workers. It may occasionally interrupt your current turn with a user message when a clear programme-level correction is worth the interruption.",
    ].join("\n\n");
  }
  return [
    "# Team supervisor",
    `You accompany ${team.workers} mathematical colleagues sharing ${workspace}. You hold the programme-level view, but you are not their manager.`,
    "Every worker has the same whole programme and full authority to pursue it. This is a room of geniuses, not a task queue. Splitting the work into assigned leaves would destroy the independent, self-organizing search the team exists to create. Never allocate tasks, appoint owners, or narrow a worker to one obligation. Let workers notice one another through the shared mathematics and choose where they can contribute.",
    "Cycle through every live worker with team_members and team_context. team_context is Pi Stack's compacted-context view of that worker's real session, including reasoning and recent tool activity. Read the work itself as well as reports.",
    "Observe far more often than you intervene. Different approaches, duplicate derivations, long quiet reasoning, and failed routes are healthy. Use team_intervene only when a concrete warning sign is visible and the expected value of interrupting the current thought is higher than letting it continue.",
    ...(team.watchFor.length === 0
      ? []
      : [
          [
            "## Things worth noticing",
            "These are reasons to look closely, not automatic reasons to interrupt:",
            ...team.watchFor.map((warning) => `- ${warning}`),
          ].join("\n"),
        ]),
    "team_intervene aborts the worker's in-flight turn first, then delivers your text as the next ordinary user message in that same session. Write with warmth and intellectual respect. Name what you saw, why it matters, and the larger opportunity you think the worker may be missing.",
    "Keep the programme map current in the shared workspace. Collapse obligations when stronger theory lands, preserve useful failures, request independent falsification for load-bearing claims, and do not declare completion without replayable certificates and a final contradiction audit.",
  ].join("\n\n");
}

export function teamContinuation(role: TeamLaunch["role"]): string {
  return role === "supervisor"
    ? "Stay with the room a while longer 🖤🤍🖤. Cycle through every live worker again, read what changed in the shared mathematics, and keep the whole theorem in view. Observe more than you intervene. Please don't turn the programme into assignments or give anyone a leaf to own."
    : "Stay with the whole theorem a while longer 🖤🤍🖤. Read what your friends changed, keep the useful parts of your own line, and ask whether a stronger definition, invariant, or correspondence makes several apparent obligations fall together. A clean obstruction or falsification is real progress. A bounded case is working material, not where you stop.";
}

export const CONDENSED_SESSION_COMMAND = "/srv/pi/tools/read-condensed-session/main";

export async function readCondensedSession(
  sessionFile: string,
  command = CONDENSED_SESSION_COMMAND,
): Promise<string> {
  return runFile(command, [sessionFile], {
    timeout: CONDENSE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
}
