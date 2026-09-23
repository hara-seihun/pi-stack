import { describe, expect, test } from "bun:test";
import { SpeechService, speechConfig } from "./service";
import type { TtsPlugin } from "./plugin";
import { speechSegments, speechText } from "./text";

describe("speech text", () => {
  test("reads the words of a Markdown message and keeps its line structure", () => {
    const source = "# Plan\n\nWe **must** ship [the fix](https://x.test) `today`.\n\n```ts\nconst a = 1;\n```\n\n- first\n- second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n<pi-remote-file src=\"/tmp/x.png\" />";
    expect(speechText(source)).toBe("Plan\n\nWe must ship the fix today.\n\nCode omitted.\n\nfirst\nsecond\n\na, b.\n1, 2.");
  });

  test("segments merge lines up to the limit and cut only an oversized line, at sentences", () => {
    expect(speechSegments("one\ntwo\n\nthree", 9)).toEqual(["one\ntwo", "three"]);
    expect(speechSegments("one\ntwo\n\nthree", 0)).toEqual(["one\ntwo\nthree"]);
    const long = "First sentence here. Second sentence here! Third one? Fourth.";
    expect(speechSegments(long, 25)).toEqual(["First sentence here.", "Second sentence here!", "Third one? Fourth."]);
    expect(speechSegments("a".repeat(30), 12)).toEqual(["a".repeat(30)]);
    expect(speechSegments("alpha beta gamma delta", 11)).toEqual(["alpha beta", "gamma delta"]);
  });
});

function fakePlugin(rate: number, spoken: string[], fail = false): TtsPlugin {
  return {
    id: "fake", name: "Fake", defaultVoice: "narrator", maxSegmentChars: 20,
    async voices() { return { ok: true, value: [{ id: "narrator", name: "narrator" }] }; },
    async speak({ text, signal }) {
      if (fail) return { ok: false, error: "engine down", status: 503 };
      spoken.push(text);
      const samples = new Int16Array(rate / 10);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 20) * 8000);
      const bytes = new Uint8Array(samples.buffer);
      return { ok: true, value: { sampleRate: rate, chunks: (async function* () { for (let at = 0; at < bytes.length; at += 400) { signal.throwIfAborted(); yield bytes.slice(at, at + 400); } })() } };
    },
  };
}

describe("speech service", () => {
  test("configuration names plugins and rejects unknown ones", () => {
    expect(speechConfig("")).toBeNull();
    expect(speechConfig('{"engines":[]}')).toBeNull();
    expect(() => speechConfig('{"engines":[{"id":"Bad!","plugin":"fish-speech"}]}')).toThrow(/invalid engine id/);
    expect(() => new SpeechService({ engines: [{ id: "x", plugin: "nope" }] })).toThrow(/unknown plugin nope/);
  });

  test("an utterance streams every segment in order through the encoder as Ogg/Opus", async () => {
    const spoken: string[] = [];
    const service = new SpeechService({ engines: [{ id: "fake", plugin: "fake" }] }, { fake: () => fakePlugin(24_000, spoken) });
    const registered = await service.handle(new Request("http://x/v1/speech/utterances", { method: "POST", body: JSON.stringify({ text: "one two\nthree four\n\nfive six seven" }) }));
    expect(registered?.status).toBe(201);
    const utterance = await registered!.json();
    expect(utterance).toMatchObject({ engine: "fake", voice: "narrator", segmentCount: 2, state: "ready" });
    const audio = await service.handle(new Request(`http://x/v1/speech/utterances/${utterance.id}/audio`));
    expect(audio?.status).toBe(200);
    expect(audio?.headers.get("content-type")).toBe("audio/ogg");
    const bytes = new Uint8Array(await audio!.arrayBuffer());
    expect(spoken).toEqual(["one two\nthree four", "five six seven"]);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("OggS");
    expect(bytes.length).toBeGreaterThan(1_000);
    let status = await (await service.handle(new Request(`http://x/v1/speech/utterances/${utterance.id}`)))!.json();
    for (let waited = 0; status.state === "speaking" && waited < 50; waited++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      status = await (await service.handle(new Request(`http://x/v1/speech/utterances/${utterance.id}`)))!.json();
    }
    expect(status).toMatchObject({ state: "spoken", error: null });
  });

  test("an engine failure before any audio answers with its error", async () => {
    const service = new SpeechService({ engines: [{ id: "fake", plugin: "fake" }] }, { fake: () => fakePlugin(24_000, [], true) });
    const utterance = await (await service.handle(new Request("http://x/v1/speech/utterances", { method: "POST", body: JSON.stringify({ text: "hello" }) })))!.json();
    const audio = await service.handle(new Request(`http://x/v1/speech/utterances/${utterance.id}/audio`));
    expect(audio?.status).toBe(503);
    expect((await audio!.json()).error).toBe("engine down");
    expect((await (await service.handle(new Request(`http://x/v1/speech/utterances/${utterance.id}`)))!.json()).state).toBe("failed");
  });
});
