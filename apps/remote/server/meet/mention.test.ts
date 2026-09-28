import { expect, test } from "bun:test";
import { addressesAgent, voiceMeetingContext } from "./mention";

test("Kenan's name and Recall's usual mishearings wake Voice; lookalike words do not", () => {
  for (const text of ["Kenan, can you unmute?", "hey kanon can you unmute yourself", "Keenan are you there", "what did kenan's notes say", "KENAN"]) {
    expect(addressesAgent(text)).toBe(true);
  }
  for (const text of ["the canon event", "a cannon", "Kennedy said", "we can analyze it", "Kenya trip", ""]) {
    expect(addressesAgent(text)).toBe(false);
  }
});

test("a reopened Voice session gets the recent transcript, newest last and bounded", () => {
  const turn = (speaker: string, text: string, startedAt: number) => ({
    id: `${startedAt}`, speakerId: speaker, speaker, text, startedAt, final: true, status: "done" as const, error: null,
  });
  const now = 10 * 60_000;
  const context = voiceMeetingContext([
    turn("Sara", "This was ten minutes ago.", 0),
    turn("Darin", "Let's look at the roadmap.", now - 120_000),
    turn("Sara", "  ", now - 60_000),
    turn("Sara", "Kenan, can you unmute?", now - 5_000),
  ], now);
  expect(context).not.toContain("ten minutes ago");
  expect(context.endsWith("Darin: Let's look at the roadmap.\nSara: Kenan, can you unmute?")).toBe(true);
  expect(context).toContain("did not hear this live");
  expect(voiceMeetingContext([], now)).toBe("");
  const long = Array.from({ length: 200 }, (_, index) => turn("Sara", `Line ${index} ${"x".repeat(80)}`, now - 200 + index));
  const bounded = voiceMeetingContext(long, now);
  expect(bounded.length).toBeLessThan(4_500);
  expect(bounded).toContain("Line 199");
  expect(bounded).not.toContain("Line 0 ");
});
