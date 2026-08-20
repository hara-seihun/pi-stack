import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-run transcripts: the orchestrator's own record of what each autonomous
 * agent did, and the only surface through which a human observer (Pi Remote)
 * can watch one. The ledger owns run custody and outcome; this owns the
 * narrative, because a run row cannot say what the agent is doing right now.
 *
 * Two files per run, both owned here:
 *
 * - `events.jsonl` — append-only `{seq, time, type, payload}` lines. A reader
 *   keeps a byte cursor, so following a long agent costs the appended tail.
 * - `live.json` — the current partial turn, replaced atomically. It is only
 *   written while somebody is looking: an observer touches a `watch` marker in
 *   the run directory, and a stale marker stops live publishing again. An
 *   unobserved agent therefore costs one small append per settled event.
 *
 * The directory is group-shared: the fleet user writes the transcript, and the
 * interactive user reads it and writes the watch marker back. Hence 0770 on
 * the directory (a narrower mode would clamp the inherited ACL mask and lock
 * the observer out of its own marker) and 0640 on the files it contains.
 */

export const DEFAULT_RUNS_ROOT =
  process.env.PI_ORCHESTRATOR_RUNS ??
  join(homedir(), ".local", "share", "pi-orchestrator", "runs");

/** How stale a `watch` marker may be before live publishing stops. Pi Remote
 * re-touches it on every poll of an open agent. */
const WATCH_TTL_MS = 60_000;
/** Minimum spacing between live snapshots while a turn streams. */
const LIVE_INTERVAL_MS = 700;
/** Transcripts older than this are pruned; the ledger keeps the outcome. */
const RETENTION_MS = 7 * 24 * 3_600_000;

export interface TranscriptLive {
  readonly activity?: string;
  readonly liveText?: string;
  readonly liveThinking?: string;
}

export class RunTranscript {
  private seq = 0;
  private lastLiveAt = 0;
  private livePublished = false;
  private readonly directory: string;
  private readonly events: string;
  private failed = false;

  constructor(runId: string, root: string = DEFAULT_RUNS_ROOT) {
    this.directory = join(root, runId);
    this.events = join(this.directory, "events.jsonl");
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o770 });
    } catch {
      // A transcript is observation, never the work: losing it must not fail
      // the run. Every later write no-ops through the same guard.
      this.failed = true;
    }
  }

  append(type: string, payload: Record<string, unknown> = {}): void {
    if (this.failed) return;
    this.seq++;
    const line = `${JSON.stringify({
      seq: this.seq,
      time: new Date().toISOString(),
      type,
      payload,
    })}\n`;
    try {
      appendFileSync(this.events, line, { mode: 0o640 });
    } catch {
      this.failed = true;
    }
  }

  /** True while an observer's marker is fresh. */
  watched(now = Date.now()): boolean {
    try {
      return now - statSync(join(this.directory, "watch")).mtimeMs < WATCH_TTL_MS;
    } catch {
      return false;
    }
  }

  /**
   * Publishes the in-flight turn when watched, and clears a previously
   * published snapshot exactly once when observation stops, so a client that
   * looks away never sees a frozen tail on its next visit.
   */
  live(state: TranscriptLive, { force = false, now = Date.now() } = {}): void {
    if (this.failed) return;
    if (!this.watched(now)) {
      if (this.livePublished) this.writeLive({ activity: "WORKING" }, now);
      this.livePublished = false;
      return;
    }
    if (!force && now - this.lastLiveAt < LIVE_INTERVAL_MS) return;
    this.lastLiveAt = now;
    this.livePublished = true;
    this.writeLive(state, now);
  }

  private writeLive(state: TranscriptLive, now: number): void {
    const file = join(this.directory, "live.json");
    const temporary = `${file}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          activity: state.activity ?? "WORKING",
          liveText: state.liveText ?? "",
          liveThinking: state.liveThinking ?? "",
          updatedAt: new Date(now).toISOString(),
        }),
        { mode: 0o640 },
      );
      renameSync(temporary, file);
    } catch {
      /* Observation must never break the run. */
    }
  }
}

/** Drops transcripts older than the retention window. Called at runner start:
 * runs are minutes long, so a startup sweep is enough and no timer is owed. */
export function pruneTranscripts(
  root: string = DEFAULT_RUNS_ROOT,
  { retentionMs = RETENTION_MS, now = Date.now() } = {},
): number {
  if (!existsSync(root)) return 0;
  let pruned = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    try {
      if (now - statSync(directory).mtimeMs <= retentionMs) continue;
      rmSync(directory, { recursive: true, force: true });
      pruned++;
    } catch {
      /* A directory that vanished or is not ours is simply skipped. */
    }
  }
  return pruned;
}
