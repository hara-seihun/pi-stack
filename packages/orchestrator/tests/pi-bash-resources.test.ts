import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { scopedBashOperations } from "../src/threads/pi-bash-resources.js";

const run = promisify(execFile);
const worker = fileURLToPath(new URL("../../runtime/pi-bash-worker.py", import.meta.url));
it("keeps unmanaged SDK shells under upstream ownership", () => expect(scopedBashOperations({})).toBeUndefined());
it("supervised worker commits output and timeout receipt and reaps escaped descendants", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-durable-shell-"));
  try {
    writeFileSync(join(root, "invocation.json"), JSON.stringify({ command: "setsid sleep 300 & echo $! > escaped.pid; printf durable; sleep 300", cwd: root, env: process.env, timeout: 0.15 }), { mode: 0o600 });
    await run("/usr/bin/python3", [worker, root], { timeout: 2000 });
    const receipt = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(receipt).toMatchObject({ timedOut: true, cancelled: false, cleanupError: null });
    expect(readFileSync(join(root, "output.log"), "utf8")).toBe("durable");
    const pid = Number(readFileSync(join(root, "escaped.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("worker keeps cancellation distinct from command success", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-durable-cancel-"));
  try {
    writeFileSync(join(root, "invocation.json"), JSON.stringify({ command: "sleep 300", cwd: root, env: process.env, timeout: 2 }), { mode: 0o600 });
    writeFileSync(join(root, "cancel"), "explicit cancel");
    await run("/usr/bin/python3", [worker, root], { timeout: 2000 });
    expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8"))).toMatchObject({ timedOut: false, cancelled: true, cleanupError: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
