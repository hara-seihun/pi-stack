import { expect, test } from "bun:test";

const previousWindow = globalThis.window;
(globalThis as any).window ??= {};
const { VoiceSession } = await import("./voice");
if (previousWindow === undefined) delete (globalThis as any).window;

test("meeting handoffs retain the live voice wording alongside canonical transcript flushing", async () => {
  const packets: any[] = [];
  let flushed = 0;
  const voice = new VoiceSession({
    sessionId: "meeting-thread",
    meetingContext: () => "Mixed meeting audio",
    handoffContext: async () => { flushed++; },
    request: async (_path, init) => {
      packets.push(JSON.parse(String(init?.body)));
      return Response.json({ workId: `work-${packets.length}` });
    },
    onState: () => {},
    onNotice: () => {},
  } as any);
  voice.generation = 1;
  voice.transcript = [
    { role: "user", text: "Earlier background conversation" },
    { role: "user", text: "How many fingers " },
    { role: "user", text: "am I holding up?" },
    { role: "assistant", text: "Checking now." },
  ];
  voice.sentTranscriptCursor = 1;
  await voice.performDelegation({ id: "first", requestId: "request-1" }, 1);
  expect(flushed).toBe(1);
  expect(packets[0].text).toContain("Live voice transcript for this handoff:\nMixed meeting audio: How many fingers am I holding up?\nKenan: Checking now.");
  expect(packets[0].text).not.toContain("Earlier background conversation");
  expect(packets[0].includeMeetingImages).toBe(true);
  voice.transcript.push({ role: "user", text: "And now?" });
  await voice.performDelegation({ id: "second", requestId: "request-2" }, 1);
  expect(packets[1].text).toContain("Mixed meeting audio: And now?");
  expect(packets[1].text).not.toContain("How many fingers");
});
