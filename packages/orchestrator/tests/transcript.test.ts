import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunTranscript, pruneTranscripts } from "../src/host/transcript.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pi-orchestrator-runs-"));
}

function events(dir: string, runId: string): Record<string, unknown>[] {
  return readFileSync(join(dir, runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function watch(dir: string, runId: string, at = Date.now()): void {
  const marker = join(dir, runId, "watch");
  writeFileSync(marker, "");
  utimesSync(marker, new Date(at), new Date(at));
}

describe("run transcripts", () => {
  it("appends monotonically sequenced events a reader can follow", () => {
    const dir = root();
    const transcript = new RunTranscript("run-1", dir);
    transcript.append("user", { text: "Do the work." });
    transcript.append("assistant", { text: "Done." });
    const written = events(dir, "run-1");
    expect(written.map((e) => e.seq)).toEqual([1, 2]);
    expect(written[0]).toMatchObject({ type: "user", payload: { text: "Do the work." } });
    expect(Date.parse(String(written[1]!.time))).toBeGreaterThan(0);
  });

  it("publishes the live turn only while an observer's marker is fresh", () => {
    const dir = root();
    const transcript = new RunTranscript("run-2", dir);
    const live = join(dir, "run-2", "live.json");

    // Nobody is looking: streaming costs nothing on disk.
    transcript.live({ liveText: "partial" });
    expect(existsSync(live)).toBe(false);

    watch(dir, "run-2");
    transcript.live({ liveText: "partial" }, { force: true });
    expect(JSON.parse(readFileSync(live, "utf8"))).toMatchObject({
      liveText: "partial",
      activity: "WORKING",
    });

    // The observer leaves; the stale tail is cleared exactly once.
    watch(dir, "run-2", Date.now() - 10 * 60_000);
    transcript.live({ liveText: "newer" }, { force: true });
    expect(JSON.parse(readFileSync(live, "utf8")).liveText).toBe("");
  });

  it("rate-limits live snapshots inside one streaming turn", () => {
    const dir = root();
    const transcript = new RunTranscript("run-3", dir);
    watch(dir, "run-3");
    const start = Date.now();
    transcript.live({ liveText: "one" }, { now: start });
    transcript.live({ liveText: "two" }, { now: start + 10 });
    expect(JSON.parse(readFileSync(join(dir, "run-3", "live.json"), "utf8")).liveText).toBe("one");
    transcript.live({ liveText: "three" }, { now: start + 5_000 });
    expect(JSON.parse(readFileSync(join(dir, "run-3", "live.json"), "utf8")).liveText).toBe("three");
  });

  it("a transcript that cannot be written never breaks the run", () => {
    const dir = root();
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, ""); // a file where the run directory would go
    const transcript = new RunTranscript("x", join(blocked, "deeper"));
    expect(() => {
      transcript.append("user", { text: "still fine" });
      transcript.live({ liveText: "still fine" }, { force: true });
    }).not.toThrow();
  });

  it("prunes transcripts past the retention window and keeps recent ones", () => {
    const dir = root();
    new RunTranscript("fresh", dir).append("user", { text: "now" });
    mkdirSync(join(dir, "stale"), { recursive: true });
    const old = Date.now() - 30 * 24 * 3_600_000;
    utimesSync(join(dir, "stale"), new Date(old), new Date(old));
    expect(pruneTranscripts(dir)).toBe(1);
    expect(existsSync(join(dir, "stale"))).toBe(false);
    expect(existsSync(join(dir, "fresh"))).toBe(true);
  });
});

describe("shared-directory access", () => {
  it("creates run directories an observer can write its watch marker into", () => {
    const dir = root();
    // The fleet runner's umask; the point of the test is the mode the
    // transcript asks for, not this process's inherited default.
    const previous = process.umask(0o007);
    try {
      new RunTranscript("shared", dir).append("user", { text: "hello" });
    } finally {
      process.umask(previous);
    }
    // 0770: a narrower mode clamps the inherited POSIX ACL mask on the
    // deployment's group-shared runs root, which would leave the observing
    // user able to read the transcript but unable to ask for a live tail.
    expect(statSync(join(dir, "shared")).mode & 0o777).toBe(0o770);
  });
});
