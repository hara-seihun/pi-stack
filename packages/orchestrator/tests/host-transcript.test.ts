import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHost } from "../src/host/pi-host.js";
import { RunTranscript } from "../src/host/transcript.js";

/**
 * The transcript is the only view an observer has of a running agent, and a
 * tool card is rendered from named argument fields. These tests pin the shape
 * a reader depends on: `args` is the tool's own object, never a serialization
 * of it.
 */

function harness(runId: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-host-"));
  const transcript = new RunTranscript(runId, dir);
  const host = new PiHost(
    { runFinished: () => {}, heartbeat: () => {},
      progress: () => {}, sessionStarted: () => {}, laneDrained: () => false },
    { resolveModel: () => undefined },
  );
  let emit: (event: unknown) => void = () => {};
  const session = { subscribe: (handler: (event: unknown) => void) => { emit = handler; return () => {}; } };
  // `publish` is the host's private session-to-transcript mirror; it is
  // exercised directly because the surface under test is the payload shape,
  // not the pi SDK session lifecycle around it.
  (host as unknown as { publish(t: RunTranscript, s: unknown): () => void }).publish(transcript, session);
  const events = () =>
    readFileSync(join(dir, runId, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  return { emit: (event: unknown) => emit(event), events };
}

describe("host transcript payloads", () => {
  it("keeps tool arguments structured so a card can read command and timeout", () => {
    const { emit, events } = harness("run-args");
    emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo hello", timeout: 1800 },
    });
    const [entry] = events();
    expect(entry!.type).toBe("tool_start");
    expect(entry!.payload.args).toEqual({ command: "echo hello", timeout: 1800 });
  });

  it("degrades an oversized argument to a labelled preview, not a blob", () => {
    const { emit, events } = harness("run-huge");
    emit({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "write",
      args: { path: "/tmp/x", content: "x".repeat(20_000) },
    });
    const args = events()[0]!.payload.args as { truncated: boolean; preview: string };
    expect(args.truncated).toBe(true);
    expect(args.preview.endsWith("… [truncated]")).toBe(true);
    expect(args.preview.length).toBeLessThan(9_000);
  });

  it("still records a tool call whose arguments cannot be serialized", () => {
    const { emit, events } = harness("run-cyclic");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    emit({ type: "tool_execution_start", toolCallId: "call-3", toolName: "bash", args: cyclic });
    expect(events()[0]!.payload.args).toEqual({ unavailable: true });
  });

  it("keeps tool output a string, because a card renders it as text", () => {
    const { emit, events } = harness("run-output");
    emit({
      type: "tool_execution_end",
      toolCallId: "call-4",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hello" }] },
      isError: false,
    });
    expect(events()[0]!.payload).toMatchObject({ name: "bash", output: "hello", error: false });
  });
});
