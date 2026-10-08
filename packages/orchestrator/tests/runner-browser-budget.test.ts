import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFileSync, readlinkSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { PiEvent, PiSession } from "../src/threads/contracts.js";
import type { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";
import { runnerSlices } from "../src/threads/runner-resources.js";
import { RunnerBudgetFixture } from "./fixtures/runner-budget.js";

const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
const nativeBrowser = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const browserCache = join(userInfo().homedir, ".agent-browser/browsers");
const chrome = [process.env.PI_TEST_CHROME_EXECUTABLE, "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ...(existsSync(browserCache) ? readdirSync(browserCache).filter(name => name.startsWith("chrome-")).map(name => join(browserCache, name, "chrome")) : [])]
  .find((path): path is string => !!path && existsSync(path));
const ctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 5000 });
async function until(check: () => boolean) {
  const end = Date.now() + 15000;
  while (!check()) { if (Date.now() > end) throw new Error("Browser budget proof did not settle"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function status(control: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(control); let text = "";
    socket.on("connect", () => socket.write('{"type":"status"}\n'));
    socket.on("data", bytes => { text += bytes; if (text.includes("\n")) { socket.end(); resolve(JSON.parse(text.trim())); } });
    socket.on("error", reject);
  });
}

it.skipIf(!manager || !nativeBrowser || !chrome)("native Chromium trees remain outside control and browser OOM preserves twenty accepted native sessions", async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = new RunnerBudgetFixture(repo, "browser-budget-");
  const { compiled, root } = fixture;
  const sessions: PiSession[] = [], events: PiEvent[][] = [];
  let opener: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  const gate = join(root, "release"), entered = join(root, "entered"), proof = join(root, "browser.jsonl");
  const server = createServer((_request, response) => response.end("<title>Runner pressure fixture</title><h1>Native browser fixture</h1>"));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    await build({ entryPoints: ["runner-host", "runner-transport"].map(name => join(repo, `packages/orchestrator/src/threads/${name}.ts`)),
      outdir: compiled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    const extension = join(root, "fixture.mjs");
    writeFileSync(extension, `import {appendFileSync,existsSync,readFileSync} from 'node:fs';
      import browser from ${JSON.stringify(pathToFileURL(join(repo, "packages/runtime/extensions/browser/index.mjs")).href)};
      export default async pi=>{
        let nativeBrowser;
        await browser(new Proxy(pi,{get(target,key){if(key==='registerTool')return tool=>{if(tool.name==='agent_browser')nativeBrowser=tool;target.registerTool(tool);};return Reflect.get(target,key);}}));
        pi.registerCommand('hold',{description:'offline browser pressure proof',handler:async(_args,ctx)=>{
          const env=globalThis[Symbol.for('pi-stack.session-environment')].getStore();
          if(env.PI_THREAD_ID==='thread-0') for(const n of [1,2]) {
            const result=await nativeBrowser.execute('browser-'+n,{args:['--executable-path',${JSON.stringify(chrome)},'--session','pressure-'+env.PI_THREAD_RESOURCE_BOUNDARY+'-'+n,'open',${JSON.stringify(url)}]},undefined,()=>{},ctx);
            appendFileSync(${JSON.stringify(proof)},JSON.stringify(result)+'\\n');
          }
          appendFileSync(${JSON.stringify(entered)},env.PI_THREAD_ID+'\\n');
          while(!existsSync(${JSON.stringify(gate)})) await new Promise(resolve=>setTimeout(resolve,10));
        }});
      };`);
    opener = runtime.createSharedPiSessionOpener({ dataDir: root, durable: true });
    for (let i = 0; i < 20; i++) {
      events[i] = [];
      const session = await opener.openSession({ threadId: `thread-${i}`, cwd: root, sessionFile: join(root, `${i}.jsonl`), args: ["--extension", extension],
        env: { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_THREAD_API_URL: "http://127.0.0.1:1/v1/threads" } }, event => { fixture.track(event); events[i].push(event); }, () => {});
      sessions.push(session);
      await session.command({ type: "prompt", id: `input-${i}`, workId: `work-${i}`, message: "/hold" });
    }
    await until(() => existsSync(entered) && readFileSync(entered, "utf8").trim().split("\n").length === 20);
    const results = readFileSync(proof, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.details?.failureCategory, JSON.stringify(result)).toBeUndefined();
      expect(JSON.stringify(result)).toContain("Runner pressure fixture");
    }
    const control = String(events[0].find(event => event.type === "runner_attached")!.control);
    const id = createHash("sha256").update(control).digest("hex").slice(0, 16);
    const before = await status(control), slices = runnerSlices(id);
    expect(before).toMatchObject({ sessions: 20, activeSessions: 20 });
    const toolGroup = ctl("show", slices.tools, "--property=ControlGroup", "--value").trim();
    const tree = execFileSync("find", [`/sys/fs/cgroup${toolGroup}`, "-name", "cgroup.procs", "-exec", "cat", "{}", ";"], { encoding: "utf8", timeout: 5000 });
    const browserPids = tree.trim().split(/\s+/).map(Number).filter(pid => { try { return /chrome|chromium/.test(readFileSync(`/proc/${pid}/cmdline`, "utf8")); } catch { return false; } });
    expect(browserPids.length).toBeGreaterThan(2);
    for (const pid of browserPids) {
      expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain(slices.tools);
      expect(Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)![1])).toBe(process.getuid!());
    }
    const chromeMain = browserPids.find(pid => !readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--type="))!;
    expect(readlinkSync(`/proc/${chromeMain}/ns/mnt`)).toBe(readlinkSync(`/proc/${before.pid}/ns/mnt`));
    const controllerGroup = ctl("show", before.unit, "--property=ControlGroup", "--value").trim();
    expect(readFileSync(`/sys/fs/cgroup${controllerGroup}/cgroup.procs`, "utf8").trim()).toBe(String(before.pid));
    const oomBefore = Number(readFileSync(`/sys/fs/cgroup${toolGroup}/memory.events`, "utf8").match(/^oom_kill (\d+)$/m)![1]);
    ctl("set-property", "--runtime", slices.tools, "MemoryHigh=128M", "MemoryMax=128M", "MemorySwapMax=0");
    await until(() => Number(readFileSync(`/sys/fs/cgroup${toolGroup}/memory.events`, "utf8").match(/^oom_kill (\d+)$/m)![1]) > oomBefore);
    expect((await status(control)).pid).toBe(before.pid);
    for (let i = 0; i < 20; i++) await sessions[i].command({ type: "get_state", id: `before-${i}` });
    await until(() => events.every((list, i) => list.some(event => event.id === `before-${i}`)));
    for (let i = 0; i < 20; i++) expect(events[i].find(event => event.id === `before-${i}`)).toMatchObject({ data: { acceptedWorkIds: [`work-${i}`], completedWorkIds: [] } });
    writeFileSync(gate, "release");
    await until(() => events.every(list => list.some(event => event.type === "agent_settled")));
    for (let i = 0; i < 20; i++) expect(events[i].filter(event => event.type === "agent_settled")).toMatchObject([{ workIds: [`work-${i}`], outcome: "complete" }]);
    expect((await status(control)).pid).toBe(before.pid);
  } finally {
    server.close();
    fixture.cleanup(() => opener?.detach());
  }
}, 40000);
