import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

it.skipIf(process.env.PI_CODEX_CGROUP_TEST !== "1")("stops setsid descendants with the owning cgroup, including SIGTERM-resistant tools, without stopping a sibling", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-process-"));
  const leftFile = join(root, "left.json"), rightFile = join(root, "right.json");
  const tool = join(root, "tool.cjs"), server = join(root, "server.cjs");
  writeFileSync(tool, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'}); child.unref();
process.on('SIGTERM',()=>{});
fs.writeFileSync(process.argv[2]+'.tmp',JSON.stringify({pid:process.pid,grandchild:child.pid})); fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
setInterval(()=>{},1000);`);
  writeFileSync(server, `const {spawn}=require('node:child_process');
const tool=spawn(process.execPath,[process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'}); tool.unref();
setInterval(()=>{},1000);`);
  let left: CodexProcess | undefined, right: CodexProcess | undefined;
  try {
    const readyLeft = waitForFile(leftFile), readyRight = waitForFile(rightFile);
    left = openCodexProcess({ binary: process.execPath, args: [server, tool, leftFile], cwd: root, env: process.env });
    right = openCodexProcess({ binary: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(rightFile)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`], cwd: root, env: process.env });
    left.child.stdout.resume(); right.child.stdout.resume();
    const [leftPids, rightPids] = (await Promise.all([readyLeft, readyRight])).map(value => JSON.parse(value));
    expect(alive(leftPids.pid)).toBe(true); expect(alive(leftPids.grandchild)).toBe(true); expect(alive(rightPids.pid)).toBe(true);
    await left.stop();
    expect(alive(leftPids.pid)).toBe(false); expect(alive(leftPids.grandchild)).toBe(false);
    expect(alive(rightPids.pid)).toBe(true);
    await right.stop();
    expect(alive(rightPids.pid)).toBe(false);
  } finally { await Promise.all([left?.stop(), right?.stop()]); rmSync(root, { recursive: true, force: true }); }
}, 12_000);
