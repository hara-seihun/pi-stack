import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Model, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { aliasProvider } from "../src/auth/provider-alias.js";
import { anthropicFilesHeaders, withAnthropicFiles } from "../src/auth/anthropic-files-provider.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const family = builtinProviders().find(provider => provider.id === "anthropic")!;
const model = { ...family.getModels()[0], provider: "anthropic-2", id: "files-test" };
const context = normalizeContext({ messages: [{ role: "user", timestamp: 0, content: [
  { type: "text", text: "What color?" }, { type: "image", mimeType: "image/png", data: "cG5n" },
] }] });

function response() {
  const events = [
    { type: "message_start", message: { id: "msg_files", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Red" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function fixture(fail = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-files-provider-")); roots.push(root);
  const bodies: any[] = [], uploads: Headers[] = [];
  const metadata = { id: "file_fixture", type: "file", expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), mime_type: "image/png", size_bytes: 3 };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.pathname === "/v1/files" && request.method === "POST") {
      uploads.push(request.headers);
      return Response.json(fail ? { error: { type: "authentication_error", message: "rejected fixture credential" } } : metadata, { status: fail ? 401 : 200 });
    }
    if (url.pathname.startsWith("/v1/files/")) return Response.json(metadata);
    expect(url.pathname).toBe("/v1/messages");
    bodies.push(await request.json());
    return response();
  }) as typeof globalThis.fetch;
  const provider = aliasProvider(withAnthropicFiles(family, root), model.provider);
  return { provider, fetch, bodies, uploads };
}

describe("Anthropic Files provider boundary", () => {
  it.each(["stream", "streamSimple"] as const)("%s rewrites after payload hooks, reuses references and keeps history intact", async method => {
    const f = await fixture(), original = structuredClone(context);
    const options = { apiKey: "sk-ant-oat-fixture", fetch: f.fetch, maxTokens: 32,
      headers: { "anthropic-beta": "fixture-beta" },
      onPayload: (payload: any) => ({ ...payload, metadata: { user_id: "hook-was-here" } }),
    };
    for (let i = 0; i < 2; i++) {
      const result = await f.provider[method](model, context, options).result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: "Red" }]);
    }
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0].get("authorization")).toBe("Bearer sk-ant-oat-fixture");
    expect(f.uploads[0].get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(f.uploads[0].get("anthropic-beta")).toContain("fixture-beta");
    expect(f.bodies).toHaveLength(2);
    for (const body of f.bodies) {
      expect(body.metadata.user_id).toBe("hook-was-here");
      expect(JSON.stringify(body)).not.toContain('"base64"');
      expect(body.messages[0].content.find((block: any) => block.type === "image").source).toEqual({ type: "file", file_id: "file_fixture" });
    }
    expect(context).toEqual(original);
  });

  it("returns an upload failure to Pi without sending the image inline", async () => {
    const f = await fixture(true);
    const result = await f.provider.streamSimple(model, context, { apiKey: "sk-ant-oat-fixture", fetch: f.fetch }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Anthropic Files API");
    expect(f.bodies).toHaveLength(0);
  });

  it("leaves other providers untouched", () => {
    const provider = { ...family, id: "openai" } as Provider;
    expect(withAnthropicFiles(provider)).toBe(provider);
  });

  it("uses API keys and respects case-insensitive header overrides", () => {
    const configured = { ...model, headers: { Authorization: "Bearer model-owned", "X-Route": "model" } } as Model<any>;
    const headers = anthropicFilesHeaders(configured, { apiKey: "api-fixture", headers: { authorization: "Bearer request-owned", "x-route": "request", "Content-Type": "application/json" } });
    expect(headers.get("x-api-key")).toBe("api-fixture");
    expect(headers.get("authorization")).toBe("Bearer request-owned");
    expect(headers.get("x-route")).toBe("request");
    expect(headers.has("content-type")).toBe(false);
  });
});
