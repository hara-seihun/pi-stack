import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A host program that sees each final platform transcript turn of a live meeting as it arrives.
 *
 * Voice is a full-duplex model with one way to act: delegating to the meeting thread, which then
 * needs a model turn. Control requests such as "next slide" or "pause the video" should not wait
 * for that. The host's hook receives every final speaker-labelled turn, acts on the ones it
 * recognises (Converge's is products/design/canvas/room-command.ts), and ignores the rest.
 * PiStack knows nothing about slides or videos; it only delivers turns.
 *
 * The hook is `PI_MEET_TRANSCRIPT_HOOK`, or an executable `~/.config/pi-stack/meet-transcript-hook`.
 * It gets the turn as JSON on stdin and `PI_REMOTE_SESSION_ID`/`PI_MEET_ROOM_ID` in its
 * environment, and should print one JSON line. Turns of one room run in order, so "next, next"
 * moves twice; a turn waits at most HOOK_TIMEOUT_MS.
 */
export type TranscriptHookTurn = { roomId: string; sessionId: string; id: string; speaker: string; speakerId: string; text: string; startedAt: number };

const HOOK_TIMEOUT_MS = 12_000;

export function transcriptHookPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PI_MEET_TRANSCRIPT_HOOK?.trim();
  // Tests never run a host's real hook.
  if (!configured && env.NODE_ENV === "test") return null;
  const candidate = configured || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-stack", "meet-transcript-hook");
  try { accessSync(candidate, constants.X_OK); return candidate; }
  catch { return null; }
}

export class TranscriptHook {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly path: () => string | null = () => transcriptHookPath(),
    private readonly log: (line: string) => void = (line) => console.log(line)) {}

  /** Queue one turn behind the room's earlier turns; never throws. */
  deliver(turn: TranscriptHookTurn): Promise<void> {
    const hook = this.path();
    if (!hook) return Promise.resolve();
    const previous = this.queues.get(turn.roomId) ?? Promise.resolve();
    const next = previous.then(() => this.run(hook, turn)).catch(() => {});
    this.queues.set(turn.roomId, next);
    void next.finally(() => { if (this.queues.get(turn.roomId) === next) this.queues.delete(turn.roomId); });
    return next;
  }

  private async run(hook: string, turn: TranscriptHookTurn): Promise<void> {
    const started = Date.now();
    const child = Bun.spawn([hook], {
      stdin: new Blob([JSON.stringify(turn)]), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PI_REMOTE_SESSION_ID: turn.sessionId, PI_MEET_ROOM_ID: turn.roomId },
    });
    const timer = setTimeout(() => child.kill(), HOOK_TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const result = stdout.trim().split("\n").at(-1) ?? "";
      // Unhandled turns are the common case and stay out of the journal.
      if (code !== 0 || !/"handled":\s*false/.test(result)) {
        this.log(JSON.stringify({ event: "meet_transcript_hook", roomId: turn.roomId, turnId: turn.id, code, ms: Date.now() - started,
          result: result.slice(0, 600), ...(code !== 0 ? { stderr: stderr.slice(-400) } : {}) }));
      }
    } finally { clearTimeout(timer); }
  }
}
