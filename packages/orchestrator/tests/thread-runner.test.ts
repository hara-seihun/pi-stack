import { build } from "esbuild";
import { createConnection, createServer } from "node:net";
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

it("keeps accepted legacy-tool execution through controller/generation handoff and refreshes tools only at idle", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const cache = join(repository, "node_modules/.cache"); mkdirSync(cache, { recursive: true });
  const compiled = mkdtempSync(join(cache, "thread-runner-"));
  const dataDir = mkdtempSync(join(tmpdir(), "thread-runner-"));
  const sessions: PiSession[] = [];
  let first: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  let second: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  let next: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  try {
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    await build({ entryPoints: ["runner-host", "runner-transport"].map(name => join(repository, `packages/orchestrator/src/threads/${name}.ts`)),
      outdir: compiled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
      plugins: [{ name: "retained-legacy-wait-contract", setup(builder) {
        builder.onLoad({ filter: /\/threads\/pi-tools\.ts$/ }, args => ({ loader: "ts", contents: readFileSync(args.path, "utf8").replace("parameters: threadWaitParameters,", `parameters: Type.Union([
          Type.Object({ action: Type.Literal("set"), reason: Type.String({ minLength: 1 }), threadIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), after: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))) }),
          Type.Object({ action: Type.Literal("clear") }),
        ]),`) }));
      } }],
    });
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    const extension = join(dataDir, "fixture.mjs");
    writeFileSync(extension, `import {appendFileSync} from 'node:fs'; export default pi => {
      pi.registerCommand('hold',{description:'fixture',handler:async()=>{
        const env=globalThis[Symbol.for('pi-stack.session-environment')].getStore();
        appendFileSync(${JSON.stringify(join(dataDir, "entered"))},env.PI_THREAD_ID+'\\n');
        if(env.PI_THREAD_ID==='four') {
          const {existsSync}=await import('node:fs');
          while(!existsSync(${JSON.stringify(join(dataDir, "release-four"))})) await new Promise(resolve=>setTimeout(resolve,5));
        } else await new Promise(resolve=>setTimeout(resolve,100));
      }});
    }`);
    const options = (threadId: string): PiSessionOptions => ({ threadId, cwd: dataDir, sessionFile: join(dataDir, `${threadId}.jsonl`), args: ["--extension", extension],
      env: { HOME: dataDir, PI_CODING_AGENT_DIR: join(dataDir, "agent"), PI_OFFLINE: "1", PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads",
        PI_THREAD_MAX_ACTIVE_SESSIONS: "2", PI_THREAD_MAX_RESIDENT_SESSIONS: "3", PI_THREAD_SESSION_KEY: threadId } });
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
    await resumed.setActive!(false); await two.setActive!(false);
    expect(await status(control)).toMatchObject({ sessions: 2, activeSessions: 0, availableSlots: 2 });
    const c: PiEvent[] = [];
    const three = await second.openSession(options("three"), event => c.push(event), () => {}); sessions.push(three);
    await three.command({ type: "get_state", id: "three-ready" });
    await until(() => c.some(event => event.id === "three-ready"));
    await three.setActive!(false);
    const changed = options("three"); changed.env.PI_THREAD_SESSION_KEY = "three-next";
    const replacement = await second.openSession(changed, event => c.push(event), () => {}); sessions.push(replacement);
    await replacement.command({ type: "get_state", id: "three-replaced" });
    await until(() => c.some(event => event.id === "three-replaced"));
    expect(c.find(event => event.id === "three-replaced")).toMatchObject({ data: { threadSessionKey: "three-next", sessionFile: changed.sessionFile } });
    await replacement.setActive!(false);
    const d: PiEvent[] = [];
    const four = await second.openSession(options("four"), event => d.push(event), () => {}); sessions.push(four);
    expect(await status(control)).toMatchObject({ sessions: 3, activeSessions: 1, threadIds: ["two", "three", "four"] });
    const e: PiEvent[] = [];
    const five = await second.openSession(options("five"), event => e.push(event), () => {}); sessions.push(five);
    await expect(second.openSession(options("six"), () => {}, () => {})).rejects.toThrow("Runner capacity busy");
    expect((await status(control)).threadIds).toEqual(expect.arrayContaining(["four", "five"]));
    await four.command({ type: "get_context", id: "old-tools" });
    await until(() => d.some(event => event.id === "old-tools"));
    const oldTools = (d.find(event => event.id === "old-tools")!.data as any).tools;
    expect(oldTools.find((tool: any) => tool.name === "thread_wait").parameters.anyOf[0].properties).not.toHaveProperty("kind");
    await four.command({ type: "prompt", id: "hold-four", workId: "work-four", message: "/hold" });
    await until(() => readFileSync(join(dataDir, "entered"), "utf8").includes("four"));
    // A new runner binary must not replace the accepted execution in the retained process.
    await build({ entryPoints: [join(repository, "packages/orchestrator/src/threads/runner-host.ts")], outdir: compiled,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const nextEntry = join(compiled, "runner-transport-next.js");
    writeFileSync(nextEntry, readFileSync(join(compiled, "runner-transport.js")));
    const nextRuntime = await import(pathToFileURL(nextEntry).href) as typeof runtime;
    second.detach();
    next = nextRuntime.createSharedPiSessionOpener({ dataDir });
    const retainedFour = d.find(event => event.type === "runner_attached") as PiEvent & PiRunnerReference;
    const recovery = options("four"); recovery.env.PI_THREAD_RUNNER_REFERENCE = JSON.stringify(retainedFour); recovery.env.PI_THREAD_RECOVERING = "1";
    const recovered: PiEvent[] = [];
    const recoveredFour = await next.openSession(recovery, event => recovered.push(event), () => {}); sessions.push(recoveredFour);
    expect(recovered.find(event => event.type === "runner_attached")).toMatchObject({ control });
    expect((await status(control)).pid).toBe(original.pid);
    await recoveredFour.command({ type: "get_state", id: "four-still-accepted" });
    await until(() => recovered.some(event => event.id === "four-still-accepted"));
    expect(recovered.find(event => event.id === "four-still-accepted")).toMatchObject({ data: { isStreaming: true, acceptedWorkIds: ["work-four"], completedWorkIds: [] } });
    const oldReference = e.find(event => event.type === "runner_attached") as PiEvent & PiRunnerReference;
    const nextOptions = options("five"); nextOptions.env.PI_THREAD_RUNNER_REFERENCE = JSON.stringify(oldReference);
    const moved: PiEvent[] = [];
    const movedFive = await next.openSession(nextOptions, event => moved.push(event), () => {}); sessions.push(movedFive);
    const newReference = moved.find(event => event.type === "runner_attached") as PiEvent & PiRunnerReference;
    expect(newReference.control).not.toBe(control);
    expect((await status(newReference.control)).pid).not.toBe(original.pid);
    expect((await status(control)).threadIds).toContain("four");
    expect(recovered.some(event => event.type === "agent_settled")).toBe(false);
    writeFileSync(join(dataDir, "release-four"), "settle");
    await until(() => recovered.some(event => event.type === "agent_settled"));
    await recoveredFour.command({ type: "prompt", id: "four-duplicate", workId: "work-four", resume: true, message: "/hold" });
    await until(() => recovered.some(event => event.id === "four-duplicate"));
    expect(readFileSync(join(dataDir, "entered"), "utf8")).toBe("one\nfour\n");
    const idleFour = options("four"); idleFour.env.PI_THREAD_RUNNER_REFERENCE = JSON.stringify(retainedFour);
    const refreshed: PiEvent[] = [];
    const refreshedFour = await next.openSession(idleFour, event => refreshed.push(event), () => {}); sessions.push(refreshedFour);
    await until(() => !existsSync(control));
    expect(refreshed.find(event => event.type === "runner_attached")).toMatchObject({ control: newReference.control });
    await refreshedFour.command({ type: "get_context", id: "new-tools" });
    await until(() => refreshed.some(event => event.id === "new-tools"));
    const newTools = (refreshed.find(event => event.id === "new-tools")!.data as any).tools;
    expect(newTools.find((tool: any) => tool.name === "thread_wait").parameters.properties).toHaveProperty("kind");
    await refreshedFour.command({ type: "prompt", id: "four-duplicate-new", workId: "work-four", resume: true, message: "/hold" });
    await until(() => refreshed.some(event => event.id === "four-duplicate-new"));
    expect(readFileSync(join(dataDir, "entered"), "utf8")).toBe("one\nfour\n");
    for (const session of sessions) await session.close().catch(() => {});
    const obsoleteControl = join(dataDir, "thread-runners", "1111111111111111.sock");
    const order: string[] = [];
    const obsolete = createServer(socket => {
      socket.once("data", data => {
        const request = JSON.parse(data.toString()); order.push(request.type);
        socket.end(`${JSON.stringify({ ok: true, ...(request.type === "status" ? { sessions: 1, activeSessions: 0, threadIds: ["six"] } : {}) })}\n`);
        if (request.type === "close") obsolete.close();
      });
    });
    await new Promise<void>(resolve => obsolete.listen(obsoleteControl, resolve));
    try {
      const idleSix = options("six"); idleSix.env.PI_THREAD_RUNNER_REFERENCE = JSON.stringify({ control: obsoleteControl, socketPath: join(dataDir, "thread-sockets", "1111111111111111.1111111111111111.sock") });
      const six = await next.openSession(idleSix, () => {}, () => {}); sessions.push(six);
      expect(order).toEqual(["status", "drain", "close"]);
      await six.close();
    } finally { if (obsolete.listening) await new Promise<void>(resolve => obsolete.close(() => resolve())); }
    const newPid = (await status(newReference.control)).pid;
    expect(await status(newReference.control)).toMatchObject({ sessions: 0, activeSessions: 0 });
    await new Promise(resolve => setTimeout(resolve, 5200));
    expect(await status(newReference.control)).toMatchObject({ sessions: 0, pid: newPid });
    next.detach(); await until(() => !existsSync(newReference.control));
  } finally {
    writeFileSync(join(dataDir, "release-four"), "cleanup");
    for (const session of sessions) await session.close().catch(() => {});
    first?.detach(); second?.detach(); next?.detach();
    rmSync(dataDir, { recursive: true, force: true }); rmSync(compiled, { recursive: true, force: true });
  }
}, 15_000);
