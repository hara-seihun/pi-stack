import { chownSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

const unit = process.argv[2];
if (!unit) throw new Error("A running Pi Remote supervisor unit is required");
const person = /^pi-remote@([a-z][a-z0-9_-]*)\.service$/.exec(unit)?.[1];
if (!person) throw new Error("A Pi Remote person unit is required");
const sourcePackage = fileURLToPath(new URL("./", import.meta.url)).replace(/\/$/, "");
const releasePackage = process.env.PI_STACK_REMOTE_SOURCE;
if (!releasePackage || !isAbsolute(releasePackage)) throw new Error("PI_STACK_REMOTE_SOURCE must name the deployed Pi Remote package");
const settingsPath = `/home/${person}/.pi/agent/settings.json`;
function selectCapturePackage(from, to) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const entry = settings.packages?.at(-1);
  const source = typeof entry === "string" ? entry : entry?.source;
  if (source === to) return;
  if (source !== from) throw new Error(`The final Pi package changed to ${source}; leaving it untouched`);
  settings.packages[settings.packages.length - 1] = typeof entry === "string" ? to : { ...entry, source: to };
  const metadata = statSync(settingsPath);
  const staging = `${settingsPath}.pi-remote-dev-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(settings, null, 2)}\n`, { mode: metadata.mode & 0o777 });
  chownSync(staging, metadata.uid, metadata.gid);
  renameSync(staging, settingsPath);
}
if (process.argv[3] === "--restore") {
  selectCapturePackage(sourcePackage, releasePackage);
  process.exit(0);
}
const parent = Number(execFileSync("systemctl", ["show", unit, "--property=MainPID", "--value"], { encoding: "utf8" }).trim());
if (!Number.isSafeInteger(parent) || parent <= 1) throw new Error(`${unit} has no running supervisor`);
const children = readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
if (children.length !== 1) throw new Error(`${unit} must have exactly one supervisor child`);
const original = children[0];
const status = readFileSync(`/proc/${original}/status`, "utf8");
const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
const gid = /^Gid:\s+(\d+)/m.exec(status)?.[1];
if (!uid || !gid) throw new Error("Could not resolve the supervisor's user");
const environment = Object.fromEntries(readFileSync(`/proc/${original}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => {
  const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)];
}));
const serverDirectory = fileURLToPath(new URL("./server/", import.meta.url));
let child;
let stopping = false;
let watcher;
let debounce;
const signalChild = () => { if (child && child.exitCode === null) child.kill("SIGUSR2"); };
const stop = () => { stopping = true; watcher?.close(); clearTimeout(debounce); signalChild(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function waitForHandoff(pid) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat[stat.lastIndexOf(")") + 2] === "Z") return;
    } catch (error) { if (error.code === "ENOENT") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The current supervisor has not finished its handoff");
}

process.kill(parent, "SIGSTOP");
try {
  process.kill(original, "SIGUSR2");
  await waitForHandoff(original);
  selectCapturePackage(releasePackage, sourcePackage);
  watcher = watch(serverDirectory, { recursive: true }, (_event, path) => {
    if (!path || !/\.(ts|mjs)$/.test(path) || path.includes(".test.")) return;
    clearTimeout(debounce);
    debounce = setTimeout(signalChild, 150);
  });
  while (!stopping) {
    child = spawn("nsenter", ["--target", String(parent), "--mount", "--setuid", uid, "--setgid", gid,
      "--", "bun", `${serverDirectory}main.ts`], {
      stdio: "inherit",
      env: { ...environment, NOTIFY_SOCKET: process.env.NOTIFY_SOCKET, PI_REMOTE_DEV_NOTIFY: "1" },
    });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    child = undefined;
    if (!stopping && code !== 75) throw new Error(`Live supervisor exited ${code}`);
  }
} finally {
  watcher?.close(); clearTimeout(debounce);
  try { selectCapturePackage(sourcePackage, releasePackage); }
  finally { process.kill(parent, "SIGCONT"); }
}
