import { afterEach, expect, test, mock } from "bun:test";
import { VoiceClient } from "./client";

const originalFetch = globalThis.fetch;
const originalBroker = process.env.PI_MODEL_BROKER_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBroker === undefined) delete process.env.PI_MODEL_BROKER_URL;
  else process.env.PI_MODEL_BROKER_URL = originalBroker;
});

test("ordinary supervisors send every Voice operation through their configured broker", async () => {
  process.env.PI_MODEL_BROKER_URL = "http://127.0.0.1:25000";
  const urls: string[] = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return Response.json({ enabled: true });
  }) as unknown as typeof fetch;
  const voice = new VoiceClient("/home/alice/work/.pi-remote");
  expect((await voice.status()).ok).toBe(true);
  expect((await voice.negotiate("thread", "sdp", "instructions")).ok).toBe(true);
  expect((await voice.heartbeat("thread", "rtc_123", 1, false)).ok).toBe(true);
  expect((await voice.close("thread", "rtc_123")).ok).toBe(true);
  expect(urls).toEqual(["status", "sessions", "sessions/rtc_123", "sessions/rtc_123"].map(path => `http://127.0.0.1:25000/v1/voice/${path}`));
});
