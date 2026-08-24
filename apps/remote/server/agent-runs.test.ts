import { expect, test } from "bun:test";
import { parseRunKey, runKey, summarizeAgentRun, tailRange, TranscriptBuffer } from "./agent-runs";
import { loadProviderManifest } from "./provider-manifest";

const MANIFEST = loadProviderManifest();
const LOCAL = { key: "local", label: "THIS MACHINE", name: "This machine" };
const WORK = { key: "work", label: "WORK", name: "Cloud" };

test("a run carries the host that owns it, and is addressed by both together", () => {
  const row = {
    id: "sol-0", task_id: "research-frontier", state: "running", started_at: 1000,
    provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh",
    observable: true, live: { activity: "THINKING" },
  };
  const local = summarizeAgentRun(row, MANIFEST, LOCAL, 5000);
  expect(local).toMatchObject({
    id: "local:sol-0", host: "local", hostName: "This machine", runId: "sol-0",
    taskId: "research-frontier", status: "running", activity: "THINKING", observable: true, elapsedMs: 4000,
  });
  expect(local.label.length).toBeGreaterThan(0);

  // The same run id on another host is a different agent, and says so.
  const work = summarizeAgentRun(row, MANIFEST, WORK, 5000);
  expect(work.id).toBe("work:sol-0");
  expect(work.hostName).toBe("Cloud");
  expect(parseRunKey(work.id)).toEqual({ host: "work", runId: "sol-0" });
  expect(parseRunKey(runKey("local", "6f6c1f0e-9a0e-4f3f-9f74-1f4c3b7a0f11")))
    .toEqual({ host: "local", runId: "6f6c1f0e-9a0e-4f3f-9f74-1f4c3b7a0f11" });
});

test("a run key that names no host, or escapes its runs directory, is refused", () => {
  expect(parseRunKey("sol-0")).toBeNull();
  expect(parseRunKey("local:../../etc/passwd")).toBeNull();
  expect(parseRunKey("local:")).toBeNull();
  expect(parseRunKey(":sol-0")).toBeNull();
  expect(parseRunKey("Local:sol-0")).toBeNull();
});

test("a settled run reports its outcome rather than an activity", () => {
  const done = summarizeAgentRun(
    { id: "done", task_id: "t", state: "done", started_at: 700, ended_at: 750, model: "gpt-5.6-luna", detail: "task complete", productive: 1 },
    MANIFEST, LOCAL, 5000,
  );
  expect(done).toMatchObject({ id: "local:done", status: "done", activity: "IDLE", summary: "task complete", productive: true, elapsedMs: 50 });
  const failed = summarizeAgentRun(
    { id: "bad", task_id: "t", state: "error", started_at: 700, ended_at: 750, model: "gpt-5.6-luna", detail: "provider refused" },
    MANIFEST, LOCAL, 5000,
  );
  expect(failed).toMatchObject({ status: "error", error: "provider refused", summary: null });
});

test("a transcript is parsed incrementally and delivered by sequence", () => {
  const buffer = new TranscriptBuffer();
  buffer.append(`${JSON.stringify({ seq: 1, time: "t", type: "user", payload: { text: "do the work" } })}\n`);
  buffer.append(`${JSON.stringify({ seq: 2, time: "t", type: "thinking", payload: { text: "considering" } })}\n`);
  expect(buffer.slice(0).map((event) => event.type)).toEqual(["user", "thinking"]);
  expect(buffer.slice(0)[0]!.text).toBe("do the work");

  // A partially flushed line is ignored until its newline arrives.
  buffer.append(JSON.stringify({ seq: 3, time: "t", type: "assistant", payload: { text: "answer" } }));
  expect(buffer.slice(2)).toEqual([]);
  buffer.append("\n");
  expect(buffer.slice(2).map((event) => event.seq)).toEqual([3]);
  expect(buffer.slice(2)[0]!.text).toBe("answer");
  expect(buffer.slice(3)).toEqual([]);

  buffer.reset(120);
  expect(buffer.offset).toBe(120);
  expect(buffer.slice(0)).toEqual([]);
});

test("a tool card reaches clients with readable argument fields", () => {
  const buffer = new TranscriptBuffer();
  for (const event of [
    { seq: 1, time: "t", type: "tool_start", payload: { toolCallId: "a", name: "bash", args: { command: "ls", timeout: 60 } } },
    // A transcript whose writer JSON-encoded its arguments still has to render
    // as a command with a timeout, not as an empty card.
    { seq: 2, time: "t", type: "tool_start", payload: { toolCallId: "b", name: "bash", args: "{\"command\":\"echo hi\",\"timeout\":1800}" } },
    { seq: 3, time: "t", type: "tool_start", payload: { toolCallId: "c", name: "bash", args: "not json at all" } },
  ]) buffer.append(`${JSON.stringify(event)}\n`);
  const events = buffer.slice(0);
  expect(events[0]!.args).toEqual({ command: "ls", timeout: 60 });
  expect(events[1]!.args).toEqual({ command: "echo hi", timeout: 1800 });
  expect(events[2]!.args).toBe("not json at all");
});

test("a fresh reader joins a long transcript at its tail, and a rotated one restarts", () => {
  expect(tailRange(5_000, -1, 1_000)).toEqual({ start: 4_000, end: 5_000, fresh: true });
  expect(tailRange(500, -1, 1_000)).toEqual({ start: 0, end: 500, fresh: true });
  expect(tailRange(5_000, 4_800, 1_000)).toEqual({ start: 4_800, end: 5_000, fresh: false });
  expect(tailRange(5_000, 0, 1_000)).toEqual({ start: 0, end: 1_000, fresh: false });
  expect(tailRange(5_000, 5_000, 1_000)).toEqual({ start: 5_000, end: 5_000, fresh: false });
  // The transcript shrank, so the cursor from the previous file is meaningless.
  expect(tailRange(100, 4_800, 1_000)).toEqual({ start: 0, end: 100, fresh: true });
});
