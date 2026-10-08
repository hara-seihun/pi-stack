import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { PiEvent, PiSession } from "../src/threads/contracts.js";
import type { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";
import { scopedBashOperations } from "../src/threads/pi-bash-resources.js";
import { runnerSlices } from "../src/threads/runner-resources.js";
import { RunnerBudgetFixture } from "./fixtures/runner-budget.js";

const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
const ctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 5000 });
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("Budget proof did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function status(control: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(control); let text = "";
    socket.on("connect", () => socket.write('{"type":"status"}\n'));
    socket.on("data", bytes => { text += bytes; if (text.includes("\n")) { socket.end(); resolve(JSON.parse(text.trim())); } });
    socket.on("error", reject);
  });
}

it.skipIf(!manager)("twenty native sessions retain accepted work and progress after an isolated tool OOM under the 8GiB boundary", async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = new RunnerBudgetFixture(repo, "runner-budget-");
  const { compiled, root } = fixture;
  const sessions: PiSession[] = [], events: PiEvent[][] = [];
  let opener: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  const gate = join(root, "release"), entered = join(root, "entered");
  try {
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    await build({ entryPoints: ["runner-host", "runner-transport"].map(name => join(repo, `packages/orchestrator/src/threads/${name}.ts`)),
      outdir: compiled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    const extension = join(root, "hold.mjs");
    writeFileSync(extension, `import {appendFileSync,existsSync} from 'node:fs'; export default pi=>{
      pi.registerCommand('hold',{description:'offline budget proof',handler:async()=>{
        const env=globalThis[Symbol.for('pi-stack.session-environment')].getStore();
        appendFileSync(${JSON.stringify(entered)},env.PI_THREAD_ID+'\\n');
        while(!existsSync(${JSON.stringify(gate)})) await new Promise(resolve=>setTimeout(resolve,10));
      }});
    }`);
    opener = runtime.createSharedPiSessionOpener({ dataDir: root, durable: true });
    for (let i = 0; i < 20; i++) {
      events[i] = [];
      const session = await opener.openSession({ threadId: `thread-${i}`, cwd: root, sessionFile: join(root, `${i}.jsonl`), args: ["--extension", extension],
        env: { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads" } }, event => { fixture.track(event); events[i].push(event); }, () => {});
      sessions.push(session);
      await session.command({ type: "prompt", id: `input-${i}`, workId: `work-${i}`, message: "/hold" });
    }
    await until(() => existsSync(entered) && readFileSync(entered, "utf8").trim().split("\n").length === 20);
    const control = String(events[0].find(event => event.type === "runner_attached")!.control);
    const id = createHash("sha256").update(control).digest("hex").slice(0, 16);
    const before = await status(control), slices = runnerSlices(id);
    expect(before).toMatchObject({ sessions: 20, activeSessions: 20 });
    expect(ctl("show", slices.boundary, "--property=MemoryMax", "--value").trim()).toBe("8589934592");
    expect(before.unit).toMatch(new RegExp(`^pi-thread-runner-${id}-[a-f0-9]{12}\\.service$`));
    expect(ctl("show", before.unit, "--property=MemoryMax", "--value").trim()).toBe("4294967296");
    const ops = scopedBashOperations({ ...process.env, PI_THREAD_RESOURCE_BOUNDARY: id, PI_THREAD_RUNNER_UNIT: before.unit }, undefined, "96M")!;
    expect((await ops.exec("python3 -c 'x=bytearray(512*1024*1024)'", root, { timeout: 5, onData: () => {} })).exitCode).not.toBe(0);
    expect((await status(control)).pid).toBe(before.pid);
    await Promise.all(sessions.map(async (_session, i) => {
      let text = "";
      expect((await ops.exec(`printf tool-${i}`, root, { timeout: 3, onData: bytes => { text += bytes; } })).exitCode).toBe(0);
      expect(text).toBe(`tool-${i}`);
    }));
    for (let i = 0; i < 20; i++) await sessions[i].command({ type: "get_state", id: `before-${i}` });
    await until(() => events.every((list, i) => list.some(event => event.id === `before-${i}`)));
    for (let i = 0; i < 20; i++) expect(events[i].find(event => event.id === `before-${i}`)).toMatchObject({ data: { acceptedWorkIds: [`work-${i}`], completedWorkIds: [] } });
    writeFileSync(gate, "release");
    await until(() => events.every(list => list.some(event => event.type === "agent_settled")));
    for (let i = 0; i < 20; i++) expect(events[i].filter(event => event.type === "agent_settled")).toMatchObject([{ workIds: [`work-${i}`], outcome: "complete" }]);
    expect(new Set(readFileSync(entered, "utf8").trim().split("\n")).size).toBe(20);
    expect((await status(control)).pid).toBe(before.pid);
  } finally {
    fixture.cleanup(() => opener?.detach());
  }
}, 20000);
