import { expect, test } from "bun:test";
import { readSpeechPreference, speechPreferenceKey, writeSpeechPreference, type SpeechPreferenceStore } from "./src/speech-preferences";

function fixture(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  const storage: Storage = { get length() { return values.size; }, clear: () => values.clear(), getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
  const store: SpeechPreferenceStore = { storage: () => storage, key: value => value };
  return { values, store };
}

test("global preferences migrate only to the first authenticated owner and are removed after persistence", () => {
  const f = fixture({ "pi-remote-speech-rate": "1.5", "pi-remote-speech-voice:engine": "voice-a" });
  expect(readSpeechPreference(f.store, "a", "rate")).toEqual({ ok: true, value: "1.5" });
  expect(readSpeechPreference(f.store, "b", "voice:engine")).toEqual({ ok: true, value: null });
  expect(readSpeechPreference(f.store, "a", "voice:engine")).toEqual({ ok: true, value: "voice-a" });
  expect(f.values.has("pi-remote-speech-rate")).toBe(false);
  expect(f.values.has("pi-remote-speech-voice:engine")).toBe(false);
  expect(readSpeechPreference(f.store, "b", "rate")).toEqual({ ok: true, value: null });
});

test("scoped writes and reads never use another person's preferences", () => {
  const f = fixture();
  expect(writeSpeechPreference(f.store, "a", "rate", "2").ok).toBe(true);
  expect(writeSpeechPreference(f.store, "b", "rate", "0.75").ok).toBe(true);
  expect(readSpeechPreference(f.store, "a", "rate")).toEqual({ ok: true, value: "2" });
  expect(readSpeechPreference(f.store, "b", "rate")).toEqual({ ok: true, value: "0.75" });
});

test("an explicit scoped preference wins over the device migration", () => {
  const f = fixture({ [speechPreferenceKey("a", "rate")]: "2", "pi-remote-speech-rate": "1.25" });
  expect(readSpeechPreference(f.store, "a", "rate")).toEqual({ ok: true, value: "2" });
  expect(f.values.has("pi-remote-speech-rate")).toBe(false);
});

test("failed reads and writes are errors, never an unset value or saved success", () => {
  const store: SpeechPreferenceStore = { storage: () => { throw new Error("Storage denied"); }, key: value => value };
  expect(readSpeechPreference(store, "a", "rate").ok).toBe(false);
  expect(writeSpeechPreference(store, "a", "rate", "2").ok).toBe(false);
  expect(readSpeechPreference(store, "", "rate").ok).toBe(false);
});
