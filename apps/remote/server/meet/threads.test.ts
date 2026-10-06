import { expect, test } from "bun:test";
import type { Thread, ThreadControl } from "pi-orchestrator/api";
import { ensureExternalMeetingThread, MEETING_MODE, MEETING_SETTINGS } from "./threads";
import { externalMeetingRequest } from "./external";
import { MeetServer } from "./server";

test("external creation uses the native live profile and succeeds without selecting Astra", async () => {
  const server = new MeetServer(() => true);
  const created: unknown[] = [];
  try {
    const response = await externalMeetingRequest(new Request("http://localhost/v1/meet/external", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ namespace: "test", eventKey: "meeting" }),
    }), server, (id, meetingId, name) => ensureExternalMeetingThread(id, meetingId, name, {
      existing: () => undefined,
      get: () => undefined,
      control: async () => { throw new Error("New meetings must not update another thread"); },
      create: async (id, meetingId, name, settings, mode) => { created.push({ id, meetingId, name, settings, mode }); },
      warn: message => { throw new Error(message); },
    }));
    expect(response!.status).toBe(200);
    const { room } = await response!.json();
    expect(created).toEqual([{ id: room.sessionId, meetingId: room.id, name: "test meeting",
      settings: { model: "sol", thinkingLevel: "low", speed: "priority" }, mode: "live" }]);
    expect(MEETING_SETTINGS).toEqual({ model: "sol", thinkingLevel: "low", speed: "priority" });
    expect(MEETING_MODE).toBe("live");
  } finally { await server.close(); }
});

for (const [model, speed, promoted] of [
  ["openai-codex/gpt-6.1-sol", "standard", true],
  ["openai-codex-8/gpt-6.1-sol", "standard", true],
  ["openai-codex/gpt-6-astra", "ultrafast", true],
  ["openai-codex/gpt-6.1-sol", "priority", false],
  ["anthropic/claude-opus-5-5", "standard", false],
  ["cerebras/zai-glm-4.7", "standard", false],
] as const) {
  test(`recurrence keeps ${model} and thinking, requests only compatible speed (${speed})`, async () => {
    const thread = { id: "thread", settings: { model, thinkingLevel: "high", speed }, metadata: {} } as Thread;
    const controls: ThreadControl[] = [];
    const owner = {
      existing: () => ({ meetingId: "room", archived: true }),
      get: () => thread,
      control: async (input: ThreadControl) => {
        controls.push(input);
        if (input.action === "settings") thread.settings = { ...thread.settings, ...input.settings };
        if (input.action === "update") {
          thread.metadata = { ...thread.metadata, ...input.metadata };
          owner.existing = () => ({ meetingId: "room", archived: false });
        }
        return { ok: true as const, value: thread };
      },
      create: async () => { throw new Error("Recurring meetings keep their thread and history"); },
      warn: (message: string) => { throw new Error(message); },
    };
    await ensureExternalMeetingThread("thread", "room", "Meeting", owner);
    expect(controls).toEqual([
      { threadId: "thread", action: "update", archived: false },
      { threadId: "thread", action: "update", metadata: { mode: "live" } },
      ...(promoted ? [{ threadId: "thread", action: "settings", settings: { speed: "priority" } } as const] : []),
    ]);
    expect(thread.settings).toEqual({ model, thinkingLevel: "high", speed: promoted ? "priority" : speed });
    controls.length = 0;
    await ensureExternalMeetingThread("thread", "room", "Meeting", owner);
    expect(controls).toEqual([]);
  });
}

test("a stable event key cannot adopt a thread belonging to another meeting", async () => {
  await expect(ensureExternalMeetingThread("thread", "room", "Meeting", {
    existing: () => ({ meetingId: "other-room", archived: false }),
    get: () => undefined,
    control: async () => { throw new Error("Must not modify another meeting"); },
    create: async () => { throw new Error("Must not replace another meeting"); },
    warn: message => { throw new Error(message); },
  })).rejects.toThrow("The external meeting's thread is unavailable");
});
