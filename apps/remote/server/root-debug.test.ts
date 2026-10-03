import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootDebugConfig, rootDebugResponse } from "./root-debug";
import { ROOT_ADMIN_HEADER, isMachineAdministrator, rootAdminAdmission, rootReplyResponse } from "../../../packages/kenan-root/src/visibility";
import { displayContextDocument } from "./context-display";
import { deriveTranscriptItems } from "./transcript-items";

const root = mkdtempSync(join(tmpdir(), "root-debug-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const token = "a".repeat(64), id = "01234567-0123-4567-89ab-0123456789ab";
const registry = [{ user: "admin", machineAdministrator: true }, { user: "person" }];
const config = { port: 19886, adminCapabilityFile: "/root/private-capability" };
const req = (path: string, headers: Record<string, string> = {}, method = "GET") => new Request(`http://router${path}`, { method, headers });
const rootRequest = (path: string, headers: Record<string, string> = {}) => req(path, headers);

describe("root is a private owner, not a hidden trace in a person's thread", () => {
  test("ordinary capabilities and forged caller/UID/admin claims grant no root session access", async () => {
    let reads = 0, fetches = 0;
    for (const path of ["/v1/admin/root-sessions", `/v1/admin/root-sessions/${id}/transcript`]) {
      const response = await rootDebugResponse(req(path, { "x-pi-remote-user": "admin", [ROOT_ADMIN_HEADER]: token, "x-pi-thread-token": "ordinary-session" }), {
        authenticatedUser: "person", persons: registry, config,
        readCapability: () => { reads++; return token; }, fetch: (async () => { fetches++; return Response.json({ trace: "ROOT_SECRET" }); }),
      });
      expect(response!.status).toBe(404);
      expect(await response!.text()).not.toContain("ROOT_SECRET");
    }
    expect(reads).toBe(0); expect(fetches).toBe(0);
    expect(isMachineAdministrator("pi-kenan", registry)).toBe(false);
    expect(isMachineAdministrator("admin", [{ user: "person", machineAdministrator: true }])).toBe(false);
  });
  test("root service admission refuses every raw route with ordinary or forged credentials", () => {
    const paths = ["/v1/admin/root-sessions", `/v1/admin/root-sessions/${id}/transcript`, "/v1/threads/list", "/v1/threads/read",
      "/v1/threads/inspect", "/v1/threads/command", "/v1/stream", `/v1/sessions/${id}/context`, `/v1/sessions/${id}/items/hash`,
      `/v1/sessions/${id}/images/hash`, `/v1/sessions/${id}/files`, "/v1/files/download", "/v1/export"];
    for (const path of paths) {
      expect(rootAdminAdmission(rootRequest(path), token).ok).toBe(false);
      expect(rootAdminAdmission(rootRequest(path, { "x-pi-remote-user": "admin", "x-pi-thread-token": "person-token" }), token).ok).toBe(false);
      expect(rootAdminAdmission(rootRequest(path, { [ROOT_ADMIN_HEADER]: "b".repeat(64) }), token).ok).toBe(false);
    }
    expect(rootAdminAdmission(rootRequest("/v1/admin/root-sessions", { [ROOT_ADMIN_HEADER]: token }), "").ok).toBe(false);
  });
  test("authenticated administrator gets explicit root list/transcript, never adds root to the person directory", async () => {
    let upstreamUrl = "", upstreamHeaders = new Headers();
    const response = await rootDebugResponse(req(`/v1/admin/root-sessions/${id}/transcript?session=person-cookie&user=person`, {
      cookie: "person-cookie", authorization: "person-auth", [ROOT_ADMIN_HEADER]: "forged", "x-pi-remote-user": "person",
    }), {
      authenticatedUser: "admin", persons: registry, config, readCapability: () => token,
      fetch: (async (url: string | URL | Request, options?: RequestInit) => {
        upstreamUrl = String(url); upstreamHeaders = new Headers(options?.headers);
        const admitted = rootAdminAdmission(new Request(upstreamUrl, options), token);
        expect(admitted.ok).toBe(true);
        return Response.json({ transcript: "ROOT_SECRET" });
      }),
    });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ transcript: "ROOT_SECRET" });
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(upstreamUrl).toBe(`http://127.0.0.1:19886/v1/admin/root-sessions/${id}/transcript`);
    expect([...upstreamHeaders]).toEqual([[ROOT_ADMIN_HEADER, token]]);
    expect(await rootDebugResponse(req("/v1/sessions"), { authenticatedUser: "admin", persons: registry, config })).toBeNull();
  });
  test("wrong methods, paths, malformed IDs and redirects do not expand the admin debug channel", async () => {
    for (const request of [req("/v1/admin/root-sessions", {}, "POST"), req("/v1/admin/root-sessions/not-an-id/transcript"), req(`/v1/admin/root-sessions/${id}/export`)]) {
      expect((await rootDebugResponse(request, { authenticatedUser: "admin", persons: registry, config }))!.status).toBe(404);
    }
    const redirect = await rootDebugResponse(req("/v1/admin/root-sessions"), { authenticatedUser: "admin", persons: registry, config,
      readCapability: () => token, fetch: (async () => new Response("ROOT_SECRET", { status: 302, headers: { location: "http://elsewhere" } })) });
    expect(redirect!.status).toBe(503); expect(await redirect!.text()).not.toContain("ROOT_SECRET");
  });
  test("absent host flag has no root debugging and changes no person route", async () => {
    const path = join(root, "host.json"); writeFileSync(path, "{}");
    expect(rootDebugConfig({ PI_STACK_HOST_FILE: path })).toBeNull();
    expect((await rootDebugResponse(req("/v1/admin/root-sessions"), { authenticatedUser: "admin", persons: registry, config: null }))!.status).toBe(404);
    expect(await rootDebugResponse(req("/v1/sessions/person/context"), { authenticatedUser: "person", persons: registry, config: null })).toBeNull();
    writeFileSync(path, '{"oneKenan":true}');
    expect(rootDebugConfig({ PI_STACK_HOST_FILE: path, PI_KENAN_CONFIG: join(root, "missing") })?.port).toBe(18821);
  });
  test("root reply channel excludes session, traces, internal errors and metadata", async () => {
    const reply = rootReplyResponse("Chosen reply");
    expect(await reply.json()).toEqual({ reply: "Chosen reply" });
    expect(reply.headers.get("cache-control")).toBe("no-store");
  });
  test("own person and room context stays fully transparent, including ask_kenan and delegated prompts", () => {
    const context = { systemPrompt: "OWN_SYSTEM", tools: [], metadata: { room: { id: "room" } }, messages: [
      { role: "user", content: "DELEGATED_PROMPT", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "OWN_THINK" }, { type: "toolCall", name: "ask_kenan", id: "call", arguments: { request: "ASK_REQUEST" } }] },
      { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "Chosen reply" }] },
    ] };
    const display = displayContextDocument(JSON.stringify(context));
    for (const text of ["OWN_SYSTEM", "DELEGATED_PROMPT", "OWN_THINK", "ASK_REQUEST", "Chosen reply"]) expect(display).toContain(text);
    const items = deriveTranscriptItems(JSON.parse(display));
    expect(items.some(item => item.head.kind === "thinking")).toBe(true);
    expect(items.some(item => item.head.kind === "toolCall")).toBe(true);
    expect(items.some(item => item.head.kind === "notice" && item.head.label === "Privacy")).toBe(false);
  });
});
