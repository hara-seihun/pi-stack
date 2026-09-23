import { build } from "esbuild";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { PiEvent, PiRunnerReference, PiSession, PiSessionOptions } from "../src/threads/contracts.js";
import type { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Runner event did not arrive");
}
async function status(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    socket.on("connect", () => socket.write('{"type":"status"}\n'));
    socket.on("data", bytes => { text += bytes; if (text.includes("\n")) { socket.end(); resolve(JSON.parse(text.trim())); } });
    socket.on("error", reject);
  });
}

it("multiplexes native sessions and keeps an accepted execution through controller detach", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const cache = join(repository, "node_modules/.cache"); mkdirSync(cache, { recursive: true });
  const compiled = mkdtempSync(join(cache, "thread-runner-"));
  const dataDir = mkdtempSync(join(tmpdir(), "thread-runner-"));
  const sessions: PiSession[] = [];
  let first: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  let second: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  try {
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    await build({ entryPoints: ["runner-host", "runner-transport"].map(name => join(repository, `packages/orchestrator/src/threads/${name}.ts`)),
      outdir: compiled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    const extension = join(dataDir, "fixture.mjs");
    writeFileSync(extension, `import {appendFileSync} from 'node:fs'; export default pi => {
      pi.registerCommand('hold',{description:'fixture',handler:async()=>{
        const env=globalThis[Symbol.for('pi-stack.session-environment')].getStore();
        appendFileSync(${JSON.stringify(join(dataDir, "entered"))},env.PI_THREAD_ID+'\\n');
        await new Promise(resolve=>setTimeout(resolve,100));
      }});
    }`);
    const options = (threadId: string): PiSessionOptions => ({ threadId, cwd: dataDir, sessionFile: join(dataDir, `${threadId}.jsonl`), args: ["--extension", extension],
      env: { HOME: dataDir, PI_CODING_AGENT_DIR: join(dataDir, "agent"), PI_OFFLINE: "1", PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads" } });
    first = runtime.createSharedPiSessionOpener({ dataDir });
    const a: PiEvent[] = [], b: PiEvent[] = [];
    const restored = options("one");
    restored.cwd = join(dataDir, "reclaimed-checkout");
    mkdirSync(restored.cwd);
    restored.env.PI_THREAD_REQUIRE_SESSION = "1";
    writeFileSync(restored.sessionFile, JSON.stringify({ type: "session", version: 3, id: "restored-one", cwd: restored.cwd, timestamp: new Date().toISOString() }) + "\n");
    const one = await first.openSession(restored, event => a.push(event), () => {});
    sessions.push(one);
    const two = await first.openSession(options("two"), event => b.push(event), () => {});
    sessions.push(two);
    await one.command({ type: "get_state", id: "one-ready" });
    await two.command({ type: "get_state", id: "two-ready" });
    await until(() => a.some(event => event.id === "one-ready") && b.some(event => event.id === "two-ready"));
    expect(b.find(event => event.id === "two-ready")).toMatchObject({ success: true });
    expect(existsSync(options("two").sessionFile)).toBe(true);
    const controls = readdirSync(join(dataDir, "thread-runners")).filter(name => name.endsWith(".sock"));
    expect(controls).toHaveLength(1);
    const control = join(dataDir, "thread-runners", controls[0]);
    const original = await status(control);
    expect(original.sessions).toBe(2);
    await one.command({ type: "prompt", id: "hold", workId: "work-one", message: "/hold" });
    await until(() => existsSync(join(dataDir, "entered")));
    await one.command({ type: "get_state", id: "preflight" });
    await until(() => a.some(event => event.id === "preflight"));
    expect(a.find(event => event.id === "preflight")).toMatchObject({ data: { isStreaming: true, acceptedWorkIds: ["work-one"], completedWorkIds: [] } });
    first.detach();
    rmSync(restored.cwd, { recursive: true });
    second = runtime.createSharedPiSessionOpener({ dataDir });
    const replay: PiEvent[] = [];
    const reference = a.find(event => event.type === "runner_attached") as PiEvent & PiRunnerReference;
    const resumed = (await second.attachSession(reference, event => replay.push(event), () => {}))!;
    expect(resumed).not.toBeNull();
    expect(existsSync(restored.cwd)).toBe(false);
    sessions.push(resumed);
    await until(() => replay.some(event => event.type === "agent_settled"));
    await resumed.command({ type: "get_state", id: "recovered" });
    await until(() => replay.some(event => event.id === "recovered"));
    expect(replay.find(event => event.id === "recovered")).toMatchObject({ data: { acceptedWorkIds: ["work-one"], completedWorkIds: ["work-one"] } });
    expect(readFileSync(join(dataDir, "entered"), "utf8")).toBe("one\n");
    expect((await status(control)).pid).toBe(original.pid);
    await resumed.command({ type: "prompt", id: "duplicate", workId: "work-one", resume: true, message: "/hold" });
    await until(() => replay.some(event => event.id === "duplicate"));
    expect(readFileSync(join(dataDir, "entered"), "utf8")).toBe("one\n");
  } finally {
    for (const session of sessions) await session.close().catch(() => {});
    first?.detach(); second?.detach();
    rmSync(dataDir, { recursive: true, force: true }); rmSync(compiled, { recursive: true, force: true });
  }
}, 10_000);
