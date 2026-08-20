import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { VoiceBroker, boundedSdp, type VoiceAccount } from "../src/voice/broker.js";
import { contextAppendEvents, parseDelegationCreated, parseTurnTranscript, utf8Chunks } from "../src/voice/protocol.js";
import { createVoiceServer } from "../src/voice/server.js";

const roots: string[] = [];
const future = Date.now() + 24 * 60 * 60_000;
const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentDir(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "voice-broker-"));
  roots.push(root);
  const auth = Object.fromEntries(
    names.map((name) => [
      name,
      { type: "oauth", access: `access-${name}`, refresh: `refresh-${name}`, expires: future, accountId: `account-${name}` },
    ]),
  );
  writeFileSync(join(root, "auth.json"), JSON.stringify(auth));
  return root;
}

function codexAccounts(ids: string[], overrides: Partial<VoiceAccount> = {}): VoiceAccount[] {
  return ids.map((id) => ({ id, provider: "openai-codex", ...overrides }));
}

function usage(usedPercent: number): Response {
  return new Response(
    JSON.stringify({ rate_limit: { primary_window: { used_percent: usedPercent, reset_at: Date.now() / 1000 + 3600 } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("VoiceBroker eligibility", () => {
  test("intersects ledger accounts with auth.json custody", () => {
    const dir = agentDir(["openai-codex", "openai-codex-2"]);
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => [
        ...codexAccounts(["openai-codex", "openai-codex-2", "openai-codex-9"]),
        { id: "anthropic", provider: "anthropic" },
      ],
    });
    expect(broker.eligibleAccounts()).toEqual(["openai-codex", "openai-codex-2"]);
    expect(broker.status()).toEqual({ enabled: true, accountCount: 2 });
  });

  test("skips cooling and access-ended accounts", () => {
    const dir = agentDir(["openai-codex", "openai-codex-2", "openai-codex-3"]);
    const now = Date.now();
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => [
        { id: "openai-codex", provider: "openai-codex", cooldownUntil: now + 60_000 },
        { id: "openai-codex-2", provider: "openai-codex", accessUntil: now - 1 },
        { id: "openai-codex-3", provider: "openai-codex", cooldownUntil: now - 1, accessUntil: now + 60_000 },
      ],
    });
    expect(broker.eligibleAccounts()).toEqual(["openai-codex-3"]);
  });

  test("orders accounts numerically for a stable rotation", () => {
    const dir = agentDir(["openai-codex-10", "openai-codex-2", "openai-codex"]);
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => codexAccounts(["openai-codex-10", "openai-codex", "openai-codex-2"]),
    });
    expect(broker.eligibleAccounts()).toEqual(["openai-codex", "openai-codex-2", "openai-codex-10"]);
  });
});

describe("VoiceBroker negotiate", () => {
  test("round robins successful calls without per-account leases", async () => {
    const dir = agentDir(["openai-codex", "openai-codex-2", "openai-codex-3"]);
    const calls: string[] = [];
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => codexAccounts(["openai-codex", "openai-codex-2", "openai-codex-3"]),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/wham/usage")) return usage(10);
        calls.push(new Headers(init?.headers).get("chatgpt-account-id")!);
        return new Response("answer", { status: 201 });
      },
    });
    for (let index = 0; index < 4; index++) expect((await broker.negotiate(offer, "test")).ok).toBe(true);
    expect(calls).toEqual([
      "account-openai-codex",
      "account-openai-codex-2",
      "account-openai-codex-3",
      "account-openai-codex",
    ]);
  });

  test("skips quota-exhausted accounts and reports full exhaustion as 429", async () => {
    const dir = agentDir(["openai-codex", "openai-codex-2"]);
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => codexAccounts(["openai-codex", "openai-codex-2"]),
      fetch: async (input) => {
        if (String(input).endsWith("/wham/usage")) return usage(100);
        throw new Error("unexpected call");
      },
    });
    const result = await broker.negotiate(offer, "test");
    expect(result).toEqual({ ok: false, status: 429, error: "Every Codex voice account is quota exhausted" });
  });

  test("fails over to the next account when a call is refused", async () => {
    const dir = agentDir(["openai-codex", "openai-codex-2"]);
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => codexAccounts(["openai-codex", "openai-codex-2"]),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/wham/usage")) return usage(0);
        const account = new Headers(init?.headers).get("chatgpt-account-id");
        if (account === "account-openai-codex") return new Response("boom", { status: 500 });
        return new Response("answer-2", { status: 200 });
      },
    });
    const result = await broker.negotiate(offer, "test");
    expect(result).toEqual({ ok: true, status: 200, sdp: "answer-2", account: "openai-codex-2" });
  });

  test("refreshes expired credentials under the auth lock and persists them", async () => {
    const dir = agentDir(["openai-codex"]);
    const expired = {
      "openai-codex": {
        type: "oauth",
        access: "stale",
        refresh: "refresh-1",
        expires: Date.now() - 1,
        accountId: "account-old",
      },
    };
    writeFileSync(join(dir, "auth.json"), JSON.stringify(expired));
    const jwt = `h.${Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-new" } }),
    ).toString("base64url")}.s`;
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => codexAccounts(["openai-codex"]),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("auth.openai.com")) {
          expect(String(init?.body)).toContain("refresh-1");
          return Response.json({ access_token: jwt, refresh_token: "refresh-2", expires_in: 3600 });
        }
        if (url.endsWith("/wham/usage")) return usage(0);
        return new Response("answer", { status: 201 });
      },
    });
    const result = await broker.negotiate(offer, "test");
    expect(result.ok).toBe(true);
    const persisted = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    expect(persisted["openai-codex"].refresh).toBe("refresh-2");
    expect(persisted["openai-codex"].accountId).toBe("account-new");
  });

  test("rejects malformed offers before selecting an account", async () => {
    const dir = agentDir(["openai-codex"]);
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => codexAccounts(["openai-codex"]),
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    expect((await broker.negotiate("bogus", "test")).status).toBe(400);
    expect(boundedSdp(offer)).toBe(true);
    expect(boundedSdp("bogus")).toBe(false);
  });
});

describe("voice protocol helpers", () => {
  test("utf8Chunks splits on byte boundaries", () => {
    const chunks = utf8Chunks("é".repeat(300), 500);
    expect(chunks.length).toBe(2);
    expect(chunks.join("")).toBe("é".repeat(300));
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(500);
  });

  test("parses delegation and turn events, ignores the rest", () => {
    expect(
      parseDelegationCreated({
        type: "delegation.created",
        item: { id: "d1", content: [{ type: "input_text", text: "do the thing" }] },
      }),
    ).toEqual({ delegationId: "d1", task: "do the thing" });
    expect(parseDelegationCreated({ type: "delegation.created", item: { id: "d1", content: [] } })).toBeNull();
    expect(parseTurnTranscript({ type: "turn.done", turn: { role: "assistant", transcript: " hi " } })).toEqual({
      role: "assistant",
      transcript: "hi",
    });
    expect(parseTurnTranscript({ type: "response.done" })).toBeNull();
  });

  test("builds chunked context events addressed to a delegation or the session", () => {
    const events = contextAppendEvents("progress", "commentary", "d1");
    expect(events).toEqual([
      {
        type: "delegation.context.append",
        delegation_item_id: "d1",
        channel: "commentary",
        content: [{ type: "input_text", text: "progress" }],
      },
    ]);
    expect(contextAppendEvents("hello", "speakable")[0]!.type).toBe("session.context.append");
    expect(contextAppendEvents("   ", "speakable")).toEqual([]);
  });
});

describe("voice HTTP server", () => {
  async function serve(broker: VoiceBroker): Promise<{ base: string; close: () => void }> {
    const server = createVoiceServer(broker);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    return { base: `http://127.0.0.1:${address.port}`, close: () => server.close() };
  }

  test("serves status and negotiates offers", async () => {
    const dir = agentDir(["openai-codex"]);
    const broker = new VoiceBroker({
      agentDir: dir,
      accounts: () => codexAccounts(["openai-codex"]),
      fetch: async (input) => {
        if (String(input).endsWith("/wham/usage")) return usage(0);
        return new Response("answer-sdp", { status: 201 });
      },
    });
    const { base, close } = await serve(broker);
    try {
      const status = await (await fetch(`${base}/v1/voice`)).json();
      expect(status).toEqual({ enabled: true, accountCount: 1, model: "gpt-live-1-codex", voice: "cove" });
      const good = await fetch(`${base}/v1/voice/offer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: offer, instructions: "hello" }),
      });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ sdp: "answer-sdp", account: "openai-codex" });
      const bad = await fetch(`${base}/v1/voice/offer`, { method: "POST", body: "not json" });
      expect(bad.status).toBe(400);
      const missing = await fetch(`${base}/v1/nothing`);
      expect(missing.status).toBe(404);
    } finally {
      close();
    }
  });
});
