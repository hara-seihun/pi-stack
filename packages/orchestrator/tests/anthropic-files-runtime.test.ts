import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import routing from "../src/extension/routing.js";
import { Store } from "../src/store.js";

it("normal Pi routing sends file references through a pooled Anthropic account", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-runtime-")), agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(root, "auth.json"), JSON.stringify({ "anthropic-2": {
    type: "oauth", access: "sk-ant-oat-fixture", refresh: "fixture", expires: Date.now() + 3600_000,
  } }));
  vi.stubEnv("PI_ORCHESTRATOR_LEDGER", join(root, "ledger.sqlite3"));
  vi.stubEnv("PI_ORCHESTRATOR_AUTH", join(root, "auth.json"));
  vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "0");
  vi.stubEnv("PI_SUBAGENT_MODEL", "");
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  store.upsertAccount({ id: "anthropic-2", provider: "anthropic" }); store.close();
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  let uploads = 0, messages = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    expect(request.headers.get("authorization")).toBe("Bearer sk-ant-oat-fixture");
    if (url.pathname === "/v1/files") {
      uploads++;
      return Response.json({ id: "file_runtime", expires_at: new Date(Date.now() + 86400_000).toISOString() });
    }
    expect(url.pathname).toBe("/v1/messages"); messages++;
    const payload = await request.json();
    expect(JSON.stringify(payload)).not.toContain('"base64"');
    expect(JSON.stringify(payload)).toContain('"file_id":"file_runtime"');
    const events = [
      { type: "message_start", message: { id: "msg_runtime", type: "message", role: "assistant", model: payload.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Red" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [{ name: "routing", factory: routing }],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(root), model: modelRuntime.getModel("anthropic", "claude-opus-4-6"),
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    await session.prompt("What color?", { images: [{ type: "image", mimeType: "image/png", data: image }] });
    expect(errors).toEqual([]);
    expect(session.model?.provider).toBe("anthropic-2");
    expect(session.messages.at(-1), JSON.stringify(session.messages.at(-1))).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(uploads).toBe(1); expect(messages).toBe(1);
    expect(JSON.stringify(session.messages)).toContain(JSON.stringify(image));
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
