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

it.skipIf(!manager)("runner death removes orphan tools and restarts the same boundary while a scope pins the dead unit", async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const cache = join(repo, "node_modules/.cache"); mkdirSync(cache, { recursive: true });
  const compiled = mkdtempSync(join(cache, "runner-service-"));
  const dataDir = mkdtempSync(join(tmpdir(), "runner-service-"));
  let opener: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  const units: string[] = [];
  const pin = `pi-thread-tool-pin-${process.pid}-${Date.now()}.scope`;
  let id: string | undefined;
  try {
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    await build({ entryPoints: [join(repo, "packages/orchestrator/src/threads/runner-transport.ts")], outdir: compiled,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    writeFileSync(join(compiled, "runner-host.js"), `
      import {createServer} from 'node:net'; import {spawn} from 'node:child_process';
      import {writeFileSync,rmSync} from 'node:fs';
      const control=process.argv[2]; rmSync(control,{force:true});
      const child=spawn('sleep',['300'],{detached:true,stdio:'ignore'}); child.unref();
      writeFileSync(process.env.HOME+'/pids',JSON.stringify({runner:process.pid,child:child.pid,proof:process.env.RUNNER_TEST_PROOF,unit:process.env.PI_THREAD_RUNNER_UNIT}));
      createServer(socket=>socket.on('data',bytes=>{
        const value=JSON.parse(bytes.toString());
        if(value.type==='open'){
          rmSync(value.options.socketPath,{force:true});
          createServer(channel=>channel.on('data',()=>channel.write('{"type":"attached"}\\n'))).listen(value.options.socketPath);
        }
        socket.write(JSON.stringify({ok:true,pid:process.pid,unit:process.env.PI_THREAD_RUNNER_UNIT})+'\\n');
      })).listen(control);
    `);
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    opener = runtime.createSharedPiSessionOpener({ dataDir, durable: true });
    const options = { threadId: "one", cwd: dataDir, sessionFile: join(dataDir, "one.jsonl"), args: [],
      env: { HOME: dataDir, RUNNER_TEST_PROOF: "forwarded without argv", PI_THREAD_API_URL: "http://127.0.0.1:1" } };
    await opener.openSession(options, () => {}, () => {});
    const control = join(dataDir, "thread-runners", readdirSync(join(dataDir, "thread-runners")).find(name => name.endsWith(".sock"))!);
    id = createHash("sha256").update(control).digest("hex").slice(0, 16);
    const first = JSON.parse(readFileSync(join(dataDir, "pids"), "utf8"));
    expect(first.unit).toMatch(new RegExp(`^pi-thread-runner-${id}-[a-f0-9]{12}\\.service$`));
    units.push(first.unit);
    // A tool scope whose processes cannot die keeps a back-reference to the dead controller.
    execFileSync("systemd-run", ["--user", "--scope", "--collect", "--quiet", `--unit=${pin}`, `--property=Wants=${first.unit}`,
      "--", "bash", "-c", "sleep 300 </dev/null >/dev/null 2>&1 &"], { timeout: 5000 });
    expect(first.proof).toBe(options.env.RUNNER_TEST_PROOF);
    expect(alive(first.child)).toBe(true);
    process.kill(first.runner, "SIGKILL");
    await until(() => !alive(first.child));
    opener.detach();
    await until(() => spawnSync("systemctl", ["--user", "is-active", first.unit], { stdio: "ignore" }).status !== 0);
    expect(execFileSync("systemctl", ["--user", "show", first.unit, "--property=LoadState", "--value"], { encoding: "utf8" }).trim()).toBe("loaded");
    await opener.openSession(options, () => {}, () => {});
    const second = JSON.parse(readFileSync(join(dataDir, "pids"), "utf8"));
    units.push(second.unit);
    expect(second.unit).not.toBe(first.unit);
    expect(second.runner).not.toBe(first.runner);
    expect(alive(second.runner)).toBe(true);
  } finally {
    opener?.detach();
    spawnSync("systemctl", ["--user", "stop", pin], { stdio: "ignore" });
    for (const unit of units) {
      spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
      spawnSync("systemctl", ["--user", "reset-failed", unit], { stdio: "ignore" });
    }
    if (id) {
      for (const slice of [`pi-thread-${id}-tools.slice`, `pi-thread-${id}.slice`]) {
        execFileSync("systemctl", ["--user", "stop", slice], { stdio: "ignore" });
        execFileSync("systemctl", ["--user", "revert", slice], { stdio: "ignore" });
      }
    }
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    rmSync(compiled, { recursive: true, force: true });
  }
}, 15_000);
