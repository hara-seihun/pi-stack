import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";

const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Runner service did not settle");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

it.skipIf(!manager)("runner death removes orphan tools and permits the same boundary to restart", async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const cache = join(repo, "node_modules/.cache"); mkdirSync(cache, { recursive: true });
  const compiled = mkdtempSync(join(cache, "runner-service-"));
  const dataDir = mkdtempSync(join(tmpdir(), "runner-service-"));
  let opener: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  let unit: string | undefined;
  try {
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    await build({ entryPoints: [join(repo, "packages/orchestrator/src/threads/runner-transport.ts")], outdir: compiled,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    writeFileSync(join(compiled, "runner-host.js"), `
      import {createServer} from 'node:net'; import {spawn} from 'node:child_process';
      import {writeFileSync,rmSync} from 'node:fs';
      const control=process.argv[2]; rmSync(control,{force:true});
      const child=spawn('sleep',['300'],{detached:true,stdio:'ignore'}); child.unref();
      writeFileSync(process.env.HOME+'/pids',JSON.stringify({runner:process.pid,child:child.pid,proof:process.env.RUNNER_TEST_PROOF}));
      createServer(socket=>socket.on('data',bytes=>{
        const value=JSON.parse(bytes.toString());
        if(value.type==='open'){
          rmSync(value.options.socketPath,{force:true});
          createServer(channel=>channel.on('data',()=>channel.write('{"type":"attached"}\\n'))).listen(value.options.socketPath);
        }
        socket.write(JSON.stringify({ok:true,pid:process.pid})+'\\n');
      })).listen(control);
    `);
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    opener = runtime.createSharedPiSessionOpener({ dataDir, durable: true });
    const options = { threadId: "one", cwd: dataDir, sessionFile: join(dataDir, "one.jsonl"), args: [],
      env: { HOME: dataDir, RUNNER_TEST_PROOF: "forwarded without argv", PI_THREAD_API_URL: "http://127.0.0.1:1" } };
    await opener.openSession(options, () => {}, () => {});
    const control = join(dataDir, "thread-runners", readdirSync(join(dataDir, "thread-runners")).find(name => name.endsWith(".sock"))!);
    unit = `pi-thread-runner-${createHash("sha256").update(control).digest("hex").slice(0, 16)}.service`;
    const first = JSON.parse(readFileSync(join(dataDir, "pids"), "utf8"));
    expect(first.proof).toBe(options.env.RUNNER_TEST_PROOF);
    expect(alive(first.child)).toBe(true);
    process.kill(first.runner, "SIGKILL");
    await until(() => !alive(first.child));
    opener.detach();
    await until(() => spawnSync("systemctl", ["--user", "is-active", unit!], { stdio: "ignore" }).status !== 0);
    await opener.openSession(options, () => {}, () => {});
    const second = JSON.parse(readFileSync(join(dataDir, "pids"), "utf8"));
    expect(second.runner).not.toBe(first.runner);
    expect(alive(second.runner)).toBe(true);
  } finally {
    opener?.detach();
    if (unit) execFileSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    rmSync(compiled, { recursive: true, force: true });
  }
}, 15_000);
