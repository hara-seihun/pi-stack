import { test, expect } from "bun:test";
import { CallProgress, voicemailGreeting, type AudioActivity, type CallProgressEffect } from "./call-progress";

const quiet = { input: false, output: false, tone: false };
function fixture() {
  const progress = new CallProgress(0), effects: CallProgressEffect[] = [];
  let now = 0;
  const audio = (duration: number, activity: AudioActivity = quiet) => {
    for (let elapsed = 0; elapsed < duration; elapsed += 100) { now += 100; effects.push(...progress.audio(activity, now)); }
  };
  return { progress, effects, audio, now: () => now };
}

test("French greeting with pauses stays muted through recording instructions and complete beep; one message drains before hangup", () => {
  const f = fixture();
  f.progress.transcript("Bonjour, vous avez rejoint la boîte vocale. Veuillez laisser votre message ");
  f.audio(7000, { input: true, output: false, tone: false });
  f.audio(1800);
  expect(f.effects).toEqual([]);
  f.progress.transcript("après le signal sonore. Après avoir laissé votre message vous pouvez le modifier en appuyant sur le carré.");
  f.audio(9000, { input: true, output: false, tone: false });
  expect(f.effects).toEqual([]);
  f.audio(400, { input: true, output: false, tone: true });
  expect(f.effects).toEqual([]);
  f.audio(700);
  expect(f.effects).toEqual([{ type: "opening", voicemail: true }]);
  f.audio(1700, { input: false, output: true, tone: false });
  f.audio(1100);
  f.audio(2400, { input: false, output: true, tone: false });
  f.audio(2900);
  expect(f.effects).toHaveLength(1);
  f.audio(100);
  expect(f.effects).toEqual([{ type: "opening", voicemail: true }, { type: "end", reason: "Voicemail message delivered" }]);
  f.audio(30000, { input: true, output: true, tone: true });
  expect(f.progress.transcript("Leave a message after the beep")).toEqual([]);
  expect(f.effects).toHaveLength(2);
});

test("voicemail without beep waits for greeting-end silence; a beep without a transcript is sufficient", () => {
  for (const beep of [false, true]) {
    const f = fixture();
    if (!beep) f.progress.transcript("Please leave a message.");
    f.audio(3000, { input: true, output: false, tone: beep });
    // A sustained tone is not a voicemail beep.
    f.audio(100);
    expect(f.effects).toEqual([]);
    if (beep) { f.audio(300, { input: true, output: false, tone: true }); f.audio(700); }
    else { f.audio(3800); expect(f.effects).toEqual([]); f.audio(100); }
    expect(f.effects).toEqual([{ type: "opening", voicemail: true }]);
  }
});

test("initial silent answer and ordinary conversation both end on sustained two-way silence, not while either side speaks", () => {
  const f = fixture();
  f.audio(2000);
  expect(f.effects).toEqual([{ type: "opening", voicemail: false }]);
  f.audio(10000, { input: false, output: true, tone: false });
  f.audio(19000);
  expect(f.effects).toHaveLength(1);
  f.audio(2000, { input: true, output: false, tone: false });
  f.audio(19900);
  expect(f.effects).toHaveLength(1);
  f.audio(100);
  expect(f.effects.at(-1)).toEqual({ type: "end", reason: "Sustained telephone silence" });
});

test("unavailable telemetry is an explicit failure, never invented silence or permission to speak", () => {
  const f = fixture();
  expect(f.progress.tick(5000)).toEqual([{ type: "end", reason: "Telephone audio activity unavailable" }]);
  expect(f.progress.tick(6000)).toEqual([]);
});

test("late voicemail recognition holds an undelivered opening, but never repeats delivered speech", () => {
  const f = fixture(); f.audio(2000);
  expect(f.progress.transcript("Please leave your message")).toEqual([{ type: "hold" }]);
  f.audio(1500, { input: true, output: false, tone: false }); f.audio(4000);
  expect(f.effects.filter(e => e.type === "opening")).toEqual([{ type: "opening", voicemail: false }, { type: "opening", voicemail: true }]);
  const g = fixture(); g.audio(2000); g.audio(1200, { input: false, output: true, tone: false });
  expect(g.progress.transcript("Leave a message after the tone.")).toEqual([]);
  g.audio(3000);
  expect(g.effects).toEqual([{ type: "opening", voicemail: false }, { type: "end", reason: "Voicemail message delivered" }]);
});

test("recognition spans transcript chunks, handles accented French and does not mistake an ordinary greeting for voicemail", () => {
  expect(voicemailGreeting("Bonjour, vous avez rejoint le répondeur de Diane")).toBe(true);
  expect(voicemailGreeting("Après avoir laissé votre message vous pouvez le modifier")).toBe(true);
  expect(voicemailGreeting("Hello, Diane speaking. How can I help?")).toBe(false);
  const f = fixture(); f.progress.transcript("Please leave "); f.progress.transcript("a message after the tone");
  f.audio(4000); expect(f.effects).toEqual([{ type: "opening", voicemail: true }]);
});
