import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Result } from "pi-orchestrator/api";
import contextMirror from "./context-mirror";
import { SupervisorRelease } from "./supervisor-release";
import { sha256 } from "./sync";

const ok: Result<void> = { ok: true, value: undefined };

test("handoff accepts the real Pi shutdown context while refusing new work", async () => {
  const environment = { ...process.env };
  const handlers = new Map<string, (...args: any[]) => any>();
  const stored: unknown[] = [];
  const events: string[] = [];
  let databaseOpen = true;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!release.accepts(request.method, new URL(request.url).pathname)) return new Response("Draining", { status: 503 });
      expect(databaseOpen).toBe(true);
      const body = await request.json();
      stored.push(body.context);
      events.push("context");
      return Response.json({ hash: sha256(JSON.stringify(body.context)) });
    },
  });
  const ctx = {
    mode: "rpc", getSystemPrompt: () => "Final context",
    sessionManager: { getBranch: () => [{ type: "message", id: "user", parentId: null, timestamp: "2026-09-15T00:00:00Z",
      message: { role: "user", content: "Retain this context", timestamp: 1 } }] },
  };
  const release = new SupervisorRelease({
    suspend() { events.push("suspend"); },
    async detach() {
      expect((await fetch(`${server.url}v1/threads`, { method: "POST" })).status).toBe(503);
      await handlers.get("session_shutdown")!({}, ctx);
      events.push("detached");
      return ok;
    },
    async closeImages() { events.push("images"); },
    stopServer() { events.push("listener"); server.stop(true); },
    closeDatabase() { events.push("database"); databaseOpen = false; },
    exit(code) { events.push(`exit:${code}`); },
  });
  try {
    process.env.PI_REMOTE_SESSION_ID = "00000000-0000-0000-0000-000000000001";
    process.env.PI_REMOTE_SERVER_URL = server.url.origin;
    process.env.PI_REMOTE_SENDER_ID = "release-user";
    process.env.PI_REMOTE_SENDER_NAME = "Release user";
    delete process.env.PI_REMOTE_CONTEXT_OWNER_PID;
    contextMirror({ on(type: string, handler: (...args: any[]) => any) { handlers.set(type, handler); }, getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
    const pending = release.release(75);
    expect(release.release(75)).toBe(pending);
    expect(await pending).toEqual(ok);
    expect(stored).toEqual([{
      systemPrompt: "Final context", tools: [],
      messages: [{
        role: "user", content: "Retain this context", timestamp: 1,
        identity: {
          id: "pi/00000000-0000-0000-0000-000000000001/user",
          timestamp: 1,
          sender: { id: "release-user", name: "Release user" },
        },
      }],
    }]);
    expect(events).toEqual(["suspend", "context", "detached", "images", "listener", "database", "exit:75"]);
    expect(await release.release(75)).toEqual(ok);
    expect(events.filter(event => event.startsWith("exit"))).toHaveLength(1);
  } finally {
    server.stop(true);
    for (const key of ["PI_REMOTE_SESSION_ID", "PI_REMOTE_SERVER_URL", "PI_REMOTE_CONTEXT_OWNER_PID", "PI_REMOTE_SENDER_ID", "PI_REMOTE_SENDER_NAME"]) {
      if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
    }
  }
});

test.each(["detach", "images"])("failed %s keeps ingestion alive and permits an explicit handoff retry", async failure => {
  let failed = true;
  const events: string[] = [];
  const release = new SupervisorRelease({
    suspend() { events.push("suspend"); },
    async detach() { return failure === "detach" && failed ? { ok: false, error: { code: "unavailable", message: "Runner close failed" } } : ok; },
    async closeImages() { if (failure === "images" && failed) throw new Error("Image close failed"); },
    stopServer() { events.push("listener"); },
    closeDatabase() { events.push("database"); },
    exit(code) { events.push(`exit:${code}`); },
  });
  expect((await release.release(75)).ok).toBe(false);
  expect(events).toEqual(["suspend"]);
  expect(release.accepts("PUT", "/v1/sessions/thread/context")).toBe(true);
  expect(release.accepts("PATCH", "/v1/sessions/thread/context")).toBe(true);
  expect(release.accepts("POST", "/v1/sessions/thread/prompt")).toBe(false);
  expect(release.accepts("GET", "/v1/health")).toBe(false);
  failed = false;
  expect(await release.release(75)).toEqual(ok);
  expect(events).toEqual(["suspend", "listener", "database", "exit:75"]);
});
