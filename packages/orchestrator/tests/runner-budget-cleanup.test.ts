import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";
import { RunnerBudgetFixture } from "./fixtures/runner-budget.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it("cleans every acquired boundary and directory even when a cleanup operation fails", () => {
  const commands: string[][] = [];
  const fixture = new RunnerBudgetFixture(repo, "budget-cleanup-", (...args) => {
    commands.push(args);
    if (args[0] === "list-units") return `${args.at(-1)!.replace("*", "0123456789ab")} loaded failed failed runner\n`;
    if (args[0] === "show") return args.includes("--property=LoadState") ? "loaded\n" : "active\n";
    if (args[0] === "stop" && args[1].endsWith(".service")) throw new Error("injected stop failure");
    return "";
  });
  fixture.track({ type: "runner_attached", control: join(fixture.root, "first.sock") });
  fixture.track({ type: "runner_attached", control: join(fixture.root, "second.sock") });
  let detached = false;
  expect(() => fixture.cleanup(() => { detached = true; })).toThrow("Runner budget fixture cleanup failed");
  expect(commands.filter(args => args[0] === "kill")).toHaveLength(2);
  expect(commands.filter(args => args[0] === "stop")).toHaveLength(6);
  expect(commands.filter(args => args[0] === "revert")).toHaveLength(4);
  expect(detached).toBe(true);
  expect(existsSync(fixture.root)).toBe(false);
  expect(existsSync(fixture.compiled)).toBe(false);
});

it.skipIf(!manager)("failed session setup removes a runner and its child before any session handle is returned", async () => {
  const fixture = new RunnerBudgetFixture(repo, "budget-startup-");
  const { compiled, root } = fixture;
  let opener: ReturnType<typeof createSharedPiSessionOpener> | undefined;
  let pids: { runner: number; child: number } | undefined;
  try {
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    await build({ entryPoints: [join(repo, "packages/orchestrator/src/threads/runner-transport.ts")], outdir: compiled,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    writeFileSync(join(compiled, "runner-host.js"), `
      import {createServer} from 'node:net'; import {spawn} from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      const child=spawn('sleep',['300'],{stdio:'ignore'});
      writeFileSync(process.env.HOME+'/pids',JSON.stringify({runner:process.pid,child:child.pid}));
      createServer(socket=>socket.on('data',()=>socket.end(JSON.stringify({ok:true,unit:process.env.PI_THREAD_RUNNER_UNIT})+'\\n'))).listen(process.argv[2]);
    `);
    const runtime = await import(pathToFileURL(join(compiled, "runner-transport.js")).href) as { createSharedPiSessionOpener: typeof createSharedPiSessionOpener };
    opener = runtime.createSharedPiSessionOpener({ dataDir: root, durable: true });
    await expect(opener.openSession({ threadId: "fails-before-session", cwd: root, sessionFile: join(root, "one.jsonl"), args: [],
      env: { HOME: root } }, event => fixture.track(event), () => {})).rejects.toThrow("owning PI_THREAD_API_URL");
    pids = JSON.parse(readFileSync(join(root, "pids"), "utf8"));
    expect(alive(pids!.runner)).toBe(true);
    expect(alive(pids!.child)).toBe(true);
  } finally {
    fixture.cleanup(() => opener?.detach());
  }
  if (!pids) throw new Error("Startup fixture did not expose its processes");
  await expect.poll(() => alive(pids!.runner) || alive(pids!.child), { timeout: 2000 }).toBe(false);
  expect(existsSync(root)).toBe(false);
  expect(existsSync(compiled)).toBe(false);
}, 10000);
