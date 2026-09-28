import { expect, test } from "bun:test";
import { pendingWork, VOICE_HEARING_MS, VOICE_MUTED_LINGER_MS, VOICE_RETRY_MS, VOICE_UNMUTED_IDLE_MS, VoiceDemand } from "./src/meet/voice-demand";

class FakeVoice {
  state = "idle";
  working = false;
  starts = 0;
  stops = 0;
  fail = false;
  async start() { this.starts++; this.state = this.fail ? "error" : "live"; }
  async stop() { this.stops++; this.state = "idle"; }
}

function harness() {
  let now = 1_000_000;
  const voice = new FakeVoice();
  const demand = new VoiceDemand(voice, () => now);
  const room = { voiceMuted: true, platformTranscript: true, voiceWake: null as any };
  const step = async (patch: Partial<typeof room> = {}, advance = 0) => {
    now += advance;
    Object.assign(room, patch);
    const mention = demand.observe(room);
    await demand.reconcile();
    return mention;
  };
  const wake = (revision: number) => ({ revision, turnId: `t${revision}`, speaker: "Sara", text: "Kenan?", at: now });
  return { voice, demand, step, wake, tick: (ms: number) => { now += ms; } };
}

test("a muted room never opens Voice until Kenan is unmuted, and closes it a minute after muting", async () => {
  const { voice, step } = harness();
  await step();
  await step({}, 30 * 60_000);
  expect(voice.starts).toBe(0);
  await step({ voiceMuted: false });
  expect(voice.state).toBe("live");
  await step({ voiceMuted: true }, 10_000);
  await step({}, VOICE_MUTED_LINGER_MS - 1);
  expect(voice.state).toBe("live");
  await step({}, 2);
  expect(voice.state).toBe("idle");
  expect([voice.starts, voice.stops]).toEqual([1, 1]);
});

test("a mention pre-warms Voice, is handed to Pi only when Voice could not hear it, and lapses after a minute", async () => {
  const { voice, step, wake } = harness();
  expect(await step({ voiceWake: wake(3) })).toBeNull();
  expect(voice.starts).toBe(0);
  const unheard = await step({ voiceWake: wake(4) }, 1_000);
  expect(unheard?.revision).toBe(4);
  expect(voice.state).toBe("live");
  expect(await step({ voiceWake: wake(5) }, VOICE_HEARING_MS - 1_000)).toMatchObject({ revision: 5 });
  expect(await step({ voiceWake: wake(6) }, VOICE_HEARING_MS)).toBeNull();
  await step({}, VOICE_MUTED_LINGER_MS + 1);
  expect(voice.state).toBe("idle");
  expect(voice.starts).toBe(1);
});

test("unmuted Voice closes after idle minutes unless Kenan speaks or has recent work, and a failed open backs off", async () => {
  const { voice, demand, step, tick } = harness();
  await step({ voiceMuted: false });
  tick(VOICE_UNMUTED_IDLE_MS - 1_000);
  demand.activity();
  await step({}, VOICE_UNMUTED_IDLE_MS - 1);
  expect(voice.state).toBe("live");
  voice.working = true;
  await step({}, VOICE_UNMUTED_IDLE_MS * 2);
  expect(voice.state).toBe("live");
  voice.working = false;
  await step({}, 1);
  expect(voice.state).toBe("idle");
  voice.fail = true;
  await step({ voiceMuted: true });
  await step({ voiceMuted: false });
  expect(voice.state).toBe("error");
  await step({}, VOICE_RETRY_MS - 1);
  expect(voice.starts).toBe(2);
  voice.fail = false;
  await step({}, 1);
  expect([voice.starts, voice.state]).toEqual([3, "live"]);
});

test("rooms without a platform transcript keep Voice open, and old unsettled delegations stop holding it", async () => {
  const { voice, step } = harness();
  await step({ platformTranscript: false });
  expect(voice.state).toBe("live");
  await step({}, 60 * 60_000);
  expect(voice.stops).toBe(0);
  expect(pendingWork([{ createdAt: 0 }], 9 * 60_000)).toBe(true);
  expect(pendingWork([{ createdAt: 0 }], 10 * 60_000)).toBe(false);
  expect(pendingWork([], 0)).toBe(false);
});

test("unmuted Voice stays open while the meeting's workers run so their results are spoken, within the work bound", async () => {
  const { voice, step } = harness();
  const running = [{ id: "root", state: "idle", held: false }, { id: "worker", state: "running", held: false }];
  await step({ voiceMuted: false, sessionId: "root", threads: running } as any);
  expect(voice.state).toBe("live");
  await step({}, VOICE_UNMUTED_IDLE_MS + 1);
  expect(voice.state).toBe("live");
  await step({ threads: [{ id: "root", state: "idle", held: false }, { id: "worker", state: "idle", held: false }] } as any);
  expect(voice.state).toBe("idle");
});
