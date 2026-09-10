import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceBroker } from "./broker";

const roots: string[] = [];
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function broker(response: Response) {
  const root = mkdtempSync(join(tmpdir(), "voice-broker-")); roots.push(root);
  const credential = join(root, "openai-api-key");
  writeFileSync(credential, "sk-unit-test");
  const network = spyOn(globalThis, "fetch").mockResolvedValue(response);
  return { value: new VoiceBroker(credential), network };
}
const offer = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";

describe("Voice API broker", () => {
  test("creates a client-delegated WebRTC session without provider credential data in the result", async () => {
    const run = broker(Response.json({ session: { id: "live-session", client_secret: "provider-private" }, transport: { sdp: "answer" } }));
    expect(await run.value.negotiate(offer, "instructions")).toEqual({ ok: true, value: {
      session: { id: "live-session" }, transport: { type: "webrtc", sdp: "answer" },
    } });
    const body = JSON.parse(String(run.network.mock.calls[0]![1]!.body));
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.transport).toEqual({ type: "webrtc", sdp: offer });
    expect(body.session.store).toBe(false);
  });

  test("refuses malformed SDP without calling OpenAI", async () => {
    const run = broker(new Response("unused"));
    expect(await run.value.negotiate("not SDP", "instructions")).toMatchObject({ ok: false, status: 400 });
    expect(run.network).not.toHaveBeenCalled();
  });

  test("keeps provider failures bounded and treats an already-closed session as closed", async () => {
    const run = broker(new Response("provider-private-detail", { status: 429 }));
    expect(await run.value.negotiate(offer, "instructions")).toEqual({ ok: false, status: 429, error: "OpenAI Live session creation failed (HTTP 429)" });
    run.network.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await run.value.close("live-session")).toEqual({ ok: true, value: { closed: true } });
  });
});
