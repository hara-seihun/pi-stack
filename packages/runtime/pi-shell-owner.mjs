import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const owned = new Map();
const completions = new WeakMap();

export function spawnOwnedShell(shell, args, options) {
  if (process.platform !== "linux") return spawn(shell, args, options);
  const helper = fileURLToPath(new URL("./pi-shell-owner.py", import.meta.url));
  const child = spawn("/usr/bin/python3", [helper, String(process.pid), shell, ...args], {
    ...options, detached: false, stdio: [...options.stdio, "pipe"],
  });
  if (child.pid) {
    owned.set(child.pid, child);
  }
  completions.set(child, new Promise(resolve => {
    let status = "";
    child.stdio[3].setEncoding("utf8");
    child.stdio[3].on("data", chunk => { status += chunk; });
    child.stdio[3].once("error", error => resolve({ ok: false, error: error.message }));
    child.stdio[3].once("end", () => {
      if (status === "") { resolve({ beforeLaunch: true }); return; }
      let records;
      try { records = status.trim().split("\n").map(line => JSON.parse(line)); }
      catch { resolve({ ok: false, error: "Invalid shell cleanup receipt" }); return; }
      const result = records.at(-1);
      if (result?.ok === true) resolve({ ok: true });
      else if (result?.ok === false && typeof result.error === "string") resolve(result);
      else resolve({ ok: false, error: "Shell owner exited without a cleanup receipt" });
    });
  }));
  child.once("exit", async () => {
    const result = await shellOwnershipResult(child);
    if (!result.ok) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  });
  return child;
}

export function cancelOwnedShell(pid) {
  const child = owned.get(pid);
  if (!child) return false;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  return true;
}

export function releaseOwnedShell(pid) {
  owned.delete(pid);
}

export async function shellOwnershipResult(child) {
  if (process.platform !== "linux") return { ok: true };
  const completion = completions.get(child);
  if (!completion) return { ok: false, error: "Shell process has no ownership scope" };
  const result = await completion;
  if (result.beforeLaunch) return child.signalCode === "SIGTERM"
    ? { ok: true } : { ok: false, error: "Shell owner failed before launch" };
  return result;
}
