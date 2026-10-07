import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { PiEvent, PiSession } from "../src/threads/contracts.js";
import type { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";
import { isPooledStartupWait } from "../src/threads/runner-startup.js";

it("recognizes native pool refusal, not generic transport or configuration failures", () => {
  for (const error of ["No eligible pooled account for anthropic/claude-opus-5-5.", "Error: Pinned model anthropic/claude-opus-5-5 has no available account", "Saved model openai-codex/gpt-6.1-sol has no eligible pooled account"])
    expect(isPooledStartupWait(error)).toBe(true);
  for (const error of ["read ECONNRESET", "connect ENOENT", "Unknown model unavailable", "No eligible pooled account", "Model not found: No eligible pooled account for x"])
    expect(isPooledStartupWait(error)).toBe(false);
});

it("acknowledges SDK readiness and returns its original startup error before channel attachment", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const cache = join(repository, "node_modules/.cache"); mkdirSync(cache, { recursive: true });
  const compiled = mkdtempSync(join(cache, "startup-runner-"));
  const dataDir = mkdtempSync(join(tmpdir(), "startup-runner-"));
  let opener: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  let session: PiSession | undefined;
  try {
    await build({ entryPoints: ["runner-host", "runner-transport"].map(name => join(repository, `packages/orchestrator/src/threads/${name}.ts`)),
      outdir: compiled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
      plugins: [{ name: "synthetic-sdk", setup(builder) {
        builder.onLoad({ filter: /\/threads\/pi-session\.ts$/ }, () => ({ loader: "ts", contents: `
          import { AsyncLocalStorage } from 'node:async_hooks';
          export const piEnvironmentScope = new AsyncLocalStorage();
          export async function openPiSession(options, output) {
            await new Promise(resolve => setTimeout(resolve, 25));
            if (options.env.FAIL_START === '1') throw new Error('No eligible pooled account for anthropic/claude-opus-5-5.');
            output({type:'session_changed',sessionId:'synthetic',sessionFile:options.sessionFile});
            return {close:async()=>{},command:async command=>output({type:'response',command:command.type,id:command.id,success:true,data:{isStreaming:false,pendingMessageCount:0}})};
          }` }));
      } }] });
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    opener = runtime.createSharedPiSessionOpener({ dataDir });
    const options = { threadId: "fixture", cwd: dataDir, sessionFile: join(dataDir, "fixture.jsonl"), args: [],
      env: { HOME: dataDir, PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads", FAIL_START: "1" } };
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(opener.openSession(options, () => {}, () => {})).rejects.toMatchObject({
        message: "Error: No eligible pooled account for anthropic/claude-opus-5-5.", nativeNotReady: true,
      });
    }
    const events: PiEvent[] = [];
    session = await opener.openSession({ ...options, env: { ...options.env, FAIL_START: "0" } }, event => events.push(event), () => {});
    await session.command({ type: "get_state", id: "ready" });
    for (let attempt = 0; attempt < 100 && !events.some(event => event.id === "ready"); attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session_changed" }), expect.objectContaining({ id: "ready", success: true })]));
  } finally {
    await session?.close(); opener?.detach();
    const controls = join(dataDir, "thread-runners");
    for (let attempt = 0; attempt < 100 && existsSync(controls) && readdirSync(controls).some(name => name.endsWith(".sock")); attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    rmSync(dataDir, { recursive: true, force: true }); rmSync(compiled, { recursive: true, force: true });
  }
});
