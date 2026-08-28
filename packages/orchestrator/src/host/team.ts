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

export function teamSystemPrompt(team: TeamLaunch, workspace: string): string {
  if (team.role === "worker") {
    return [
      `You are worker ${team.slot} of ${team.workers} colleagues sharing ${workspace}.`,
      "When your Pi turn settles, the host tells the supervisor that you are idle and waits. The supervisor's response becomes your next ordinary user message in this same session.",
    ].join("\n\n");
  }
  return [
    `You accompany ${team.workers} colleagues sharing ${workspace}.`,
    "An idle worker appears as an ordinary user message. Your assistant response is delivered verbatim as that worker's next ordinary user message. Read its incremental compressed context when needed, then respond to the worker directly.",
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
