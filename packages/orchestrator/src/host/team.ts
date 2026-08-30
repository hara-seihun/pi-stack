import { execFile } from "node:child_process";

import type { TeamLaunch } from "./types.js";

const CONDENSE_TIMEOUT_MS = 55_000;

function runFile(
  command: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: options.timeout, maxBuffer: options.maxBuffer, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${String(error)}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** A solo session ends its shift by ending its turn. In a room, a settled
 * turn already means "idle, hand me to the other member", so the exit needs
 * its own word or there is none: a worker whose supervisor keeps answering
 * could not stop, and neither could a supervisor whose workers keep waking
 * it. `end_shift` is that word, and both roles are told it is theirs. */
const LEAVING =
  "Ending a turn here means idle, not finished, so leaving has its own word: call `end_shift` " +
  "whenever you want this shift over — the work is done, there is nothing useful left for you " +
  "here, or you would simply rather stop. Your turn finishes normally, then the session closes " +
  "and nothing re-prompts you. Write down whatever should outlive you first; the files and the " +
  "shared record survive the session, this conversation does not.";

export function teamSystemPrompt(team: TeamLaunch, workspace: string): string {
  if (team.role === "worker") {
    return [
      `You are worker ${team.slot} of ${team.workers} colleagues sharing ${workspace}.`,
      "When your Pi turn settles, the host tells the supervisor that you are idle and waits. The supervisor's response becomes your next ordinary user message in this same session.",
      LEAVING,
    ].join("\n\n");
  }
  return [
    `You accompany ${team.workers} colleagues sharing ${workspace}.`,
    "An idle worker appears as an ordinary user message. Your assistant response is delivered verbatim as that worker's next ordinary user message. Read its incremental compressed context when needed, then respond to the worker directly.",
    LEAVING,
  ].join("\n\n");
}

export const CONDENSED_SESSION_COMMAND = "/srv/pi/tools/read-condensed-session/main";

export async function readCondensedSession(
  sessionFile: string,
  since: string,
  command = CONDENSED_SESSION_COMMAND,
): Promise<string> {
  return runFile(command, ["--since", since, sessionFile], {
    timeout: CONDENSE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
}
