import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { CALL_AUDIO_FRAME_BYTES, openSignalCallAudio } from "./signal-call-audio";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function socketServer(path: string): Promise<{ server: Server; connected: Promise<Socket> }> {
  let accept!: (socket: Socket) => void;
  const connected = new Promise<Socket>(resolve => { accept = resolve; });
  const server = createServer(socket => accept(socket));
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve({ server, connected }));
  });
}

test("the call tunnel socket reframes its 10 ms stream into 20 ms browser frames in both directions", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-call-audio-"));
  roots.push(root);
  const path = join(root, "call.sock");
  const listening = await socketServer(path);
  const opened = await openSignalCallAudio(`unix:${path}`, `unix:${path}`, () => { throw new Error("unexpected audio failure"); });
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const tunnel = await listening.connected;
  const remote = new Promise<Uint8Array>(resolve => opened.value.onRemote(resolve));
  const remoteFrame = new Uint8Array(CALL_AUDIO_FRAME_BYTES).fill(3);
  tunnel.write(remoteFrame.subarray(0, 400));
  tunnel.write(remoteFrame.subarray(400, 960));
  tunnel.write(remoteFrame.subarray(960));
  expect(await remote).toEqual(remoteFrame);

  const microphone = new Promise<Buffer>(resolve => {
    let bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    tunnel.on("data", value => {
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.byteLength >= CALL_AUDIO_FRAME_BYTES) resolve(bytes.subarray(0, CALL_AUDIO_FRAME_BYTES));
    });
  });
  const microphoneFrame = new Uint8Array(CALL_AUDIO_FRAME_BYTES).fill(9);
  opened.value.write(microphoneFrame);
  expect(new Uint8Array(await microphone)).toEqual(microphoneFrame);
  await opened.value.close();
  tunnel.destroy();
});

test("host audio device names fail instead of being guessed as socket paths", async () => {
  const opened = await openSignalCallAudio("Built-in Microphone", "Built-in Speakers", () => {});
  expect(opened).toMatchObject({ ok: false, error: { code: "call_audio" } });
  if (!opened.ok) expect(opened.error.message).toContain("pipe mode");
});
