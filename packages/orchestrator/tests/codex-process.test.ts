import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, watch, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { openCodexProcess, type CodexProcess } from "../src/cores/codex-process.js";

function waitForFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = watch(join(path, ".."), () => check());
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Process fixture did not start")); }, 5_000);
    const check = () => { if (existsSync(path)) { clearTimeout(timer); watcher.close(); resolve(readFileSync(path, "utf8")); } };
    check();
  });
}
function alive(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; }
  catch { return false; }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-process-"));
  const tool = join(root, "tool.cjs"), server = join(root, "server.cjs"), middle = join(root, "middle.cjs");
  writeFileSync(tool, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'}); child.unref();
process.on('SIGTERM',()=>{});
fs.writeFileSync(process.argv[2]+'.tmp',JSON.stringify({pid:process.pid,grandchild:child.pid})); fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
setInterval(()=>{},1000);`);
  writeFileSync(middle, `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'}); child.unref();`);
  writeFileSync(server, `const {spawn}=require('node:child_process');
const middle=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4]],{detached:true,stdio:'ignore'}); middle.unref();
process.stdin.on('data',()=>process.exit(0)); setInterval(()=>{},1000);`);
  return { root, tool, server, middle, args(file: string) { return [server, middle, tool, file]; } };
}
function drain(owner: CodexProcess) { owner.child.stdout.resume(); owner.child.stderr.resume(); }
const linux = it.skipIf(process.platform !== "linux");

linux("stops detached double-forked tools and their children without stopping a sibling", async () => {
  const f = fixture(), leftFile = join(f.root, "left.json"), rightFile = join(f.root, "right.json");
  let left: CodexProcess | undefined, right: CodexProcess | undefined;
  try {
    const readyLeft = waitForFile(leftFile), readyRight = waitForFile(rightFile);
    left = openCodexProcess({ binary: process.execPath, args: f.args(leftFile), cwd: f.root, env: process.env });
    right = openCodexProcess({ binary: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(rightFile)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`], cwd: f.root, env: process.env });
    drain(left); drain(right);
    const [leftPids, rightPids] = (await Promise.all([readyLeft, readyRight])).map(value => JSON.parse(value));
    expect(alive(leftPids.pid)).toBe(true); expect(alive(leftPids.grandchild)).toBe(true); expect(alive(rightPids.pid)).toBe(true);
    await Promise.all([left.stop(), left.stop()]);
    expect(alive(leftPids.pid)).toBe(false); expect(alive(leftPids.grandchild)).toBe(false);
    expect(alive(rightPids.pid)).toBe(true);
    await right.stop(); expect(alive(rightPids.pid)).toBe(false);
  } finally { await Promise.all([left?.stop(), right?.stop()]); rmSync(f.root, { recursive: true, force: true }); }
});

linux("inherits the caller's mount namespace, environment, cwd, and stdio without putting env values in arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-namespace-"));
  const secret = "fixture-token-not-an-argument";
  const owner = openCodexProcess({ binary: process.execPath, args: ["-e", `const fs=require('node:fs');
process.stdin.once('data',value=>{console.log(JSON.stringify({pid:process.pid,mount:fs.readlinkSync('/proc/self/ns/mnt'),cwd:process.cwd(),secret:process.env.CODEX_FIXTURE_SECRET,input:value.toString()}));console.error('stderr-inherited')});setInterval(()=>{},1000);`],
    cwd: root, env: { ...process.env, CODEX_FIXTURE_SECRET: secret } });
  const lines = createInterface({ input: owner.child.stdout });
  const line = new Promise<string>(resolve => lines.once("line", resolve));
  let stderr = ""; owner.child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    owner.child.stdin.write("private stdin");
    const data = JSON.parse(await line);
    expect(data).toMatchObject({ mount: readlinkSync("/proc/self/ns/mnt"), cwd: root, secret, input: "private stdin" });
    expect(readFileSync(`/proc/${owner.child.pid}/cmdline`, "utf8")).not.toContain(secret);
    expect(readlinkSync(`/proc/${owner.child.pid}/ns/mnt`)).toBe(readlinkSync("/proc/self/ns/mnt"));
    await owner.stop(); expect(stderr).toContain("stderr-inherited");
  } finally { lines.close(); await owner.stop(); rmSync(root, { recursive: true, force: true }); }
});

linux("owner SIGKILL closes the lifeline and reaps adopted tools without killing another owner", async () => {
  const f = fixture(), leftFile = join(f.root, "left.json"), rightFile = join(f.root, "right.json");
  const source = fileURLToPath(new URL("../src/cores/codex-process.ts", import.meta.url));
  const ownerFile = join(f.root, "owner.mjs");
  writeFileSync(ownerFile, `import {openCodexProcess} from ${JSON.stringify(new URL(`file://${source}`).href)};
const owner=openCodexProcess({binary:process.execPath,args:JSON.parse(process.argv[2]),cwd:process.cwd(),env:process.env});
owner.child.stdout.resume();owner.child.stderr.resume();console.log(JSON.stringify({supervisor:owner.child.pid,mount:(await import('node:fs')).readlinkSync('/proc/self/ns/mnt')}));`);
  let left: ChildProcessWithoutNullStreams | undefined, sibling: CodexProcess | undefined;
  let supervisorPid: number | undefined;
  try {
    const readyLeft = waitForFile(leftFile), readyRight = waitForFile(rightFile);
    left = spawn(process.execPath, [ownerFile, JSON.stringify(f.args(leftFile))], { cwd: f.root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    left.stderr.resume();
    const output = createInterface({ input: left.stdout });
    const metadata = await new Promise<{ supervisor: number; mount: string }>(resolve => output.once("line", line => resolve(JSON.parse(line))));
    output.close(); supervisorPid = metadata.supervisor;
    sibling = openCodexProcess({ binary: process.execPath, args: f.args(rightFile), cwd: f.root, env: process.env }); drain(sibling);
    const [leftPids, rightPids] = (await Promise.all([readyLeft, readyRight])).map(value => JSON.parse(value));
    expect(readlinkSync(`/proc/${leftPids.pid}/ns/mnt`)).toBe(metadata.mount);
    expect(alive(supervisorPid)).toBe(true);
    const killed = new Promise<void>(resolve => left!.once("close", () => resolve()));
    left.kill("SIGKILL"); await killed;
    await expect.poll(() => [supervisorPid!, leftPids.pid, leftPids.grandchild].some(alive), { timeout: 5_000, interval: 10 }).toBe(false);
    expect(alive(rightPids.pid)).toBe(true); expect(alive(rightPids.grandchild)).toBe(true);
  } finally {
    left?.kill("SIGKILL");
    if (supervisorPid && alive(supervisorPid)) process.kill(supervisorPid, "SIGTERM");
    await sibling?.stop(); rmSync(f.root, { recursive: true, force: true });
  }
}, 10_000);

linux("natural app-server exit cleans detached descendants and immediate stop cannot start late work", async () => {
  const f = fixture(), pidsFile = join(f.root, "pids.json"), marker = join(f.root, "late");
  let owner: CodexProcess | undefined;
  try {
    const ready = waitForFile(pidsFile);
    owner = openCodexProcess({ binary: process.execPath, args: f.args(pidsFile), cwd: f.root, env: process.env }); drain(owner);
    const pids = JSON.parse(await ready);
    const done = new Promise<void>(resolve => owner!.child.once("close", () => resolve()));
    owner.child.stdin.write("exit"); await done;
    expect(alive(pids.pid)).toBe(false); expect(alive(pids.grandchild)).toBe(false);
    await owner.stop();
    owner = openCodexProcess({ binary: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`], cwd: f.root, env: process.env }); drain(owner);
    await owner.stop();
    expect(existsSync(marker)).toBe(false);
  } finally { await owner?.stop(); rmSync(f.root, { recursive: true, force: true }); }
});
