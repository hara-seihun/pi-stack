import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convergeEnabled, convergeSshArguments, convergeTools, executeConverge, type ConvergeOperation } from "../src/threads/converge.js";
import { CONVERGE_WORKER } from "../src/threads/converge-worker.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "converge-test-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = { HOME: process.env.HOME, PATH: process.env.PATH };
function local(operation: ConvergeOperation, root: string, signal?: AbortSignal) {
  return executeConverge(operation, { env, signal, launch: (_args, remoteEnv) =>
    spawn("python3", ["-u", "-c", `import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN)\n${CONVERGE_WORKER}`], { env: { ...remoteEnv, HOME: root }, stdio: "pipe" }) });
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture did not become ready");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("Converge reach", () => {
  it("is absent with the flag off and for anyone except the fixed Hara person", () => {
    const file = join(fixture(), "host.json");
    const config = { ...env, PI_STACK_HOST_CONFIG: file, PI_REMOTE_SENDER_ID: "kenan" };
    expect(convergeTools(config)).toEqual([]);
    writeFileSync(file, "{}");
    expect(convergeTools(config)).toEqual([]);
    writeFileSync(file, '{"oneKenan":"true"}');
    expect(convergeEnabled(config)).toBe(false);
    writeFileSync(file, '{"oneKenan":true}');
    expect(convergeTools(config).map(tool => tool.name)).toEqual(["converge"]);
    expect(convergeTools({ ...config, PI_REMOTE_SENDER_ID: "sybil", USER: "kenan" })).toEqual([]);
    expect(convergeTools({ ...config, PI_REMOTE_SENDER_ID: undefined, USER: "kenan" })).toEqual([]);
  });

  it("sends only the requested operation, with no thread credentials, agent forwarding or tunnel changes", async () => {
    let sent = "";
    const root = fixture();
    const result = await executeConverge({ action: "bash", command: "printf 'hello 🖤'" }, {
      env: { ...env, PI_REMOTE_SENDER_ID: "kenan", PI_THREAD_TOKEN: "private", SSH_AUTH_SOCK: "/private/socket", PERSONAL_MEMORY: "private" },
      launch: (args, remoteEnv) => {
        expect(args).toEqual(convergeSshArguments());
        expect(args).toContain("converge-kenan");
        expect(args).toContain("ClearAllForwardings=yes");
        expect(args).toContain("ControlPath=none");
        expect(args).toContain("-a");
        expect(Object.keys(remoteEnv).sort()).toEqual(["HOME", "LANG", "PATH"]);
        const child = spawn("python3", ["-u", "-c", CONVERGE_WORKER], { env: { ...remoteEnv, HOME: root }, stdio: "pipe" });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((data: string) => { sent += data; return write(data); }) as typeof child.stdin.write;
        return child;
      },
    });
    expect(JSON.parse(sent)).toEqual({ action: "bash", command: "printf 'hello 🖤'", timeout: 55 });
    expect(result).toMatchObject({ ok: true, value: { output: "hello 🖤", exitCode: 0, stopped: null } });
  });

  it("writes and reads remote paths and atomically applies disjoint edits against the original, not intermediate output", async () => {
    const root = fixture(), path = "repo's name/file.txt";
    expect(await local({ action: "write", path, content: "alpha βeta gamma\n" }, root)).toMatchObject({ ok: true });
    expect(await local({ action: "edit", path, edits: [{ oldText: "alpha", newText: "gamma" }, { oldText: "gamma", newText: "delta" }] }, root)).toMatchObject({ ok: true });
    expect(await local({ action: "read", path }, root)).toMatchObject({ ok: true, value: { text: "gamma βeta delta\n", truncated: false } });
    const before = readFileSync(join(root, path), "utf8");
    expect(await local({ action: "edit", path, edits: [{ oldText: "gamma", newText: "changed" }, { oldText: "missing", newText: "!" }] }, root)).toMatchObject({ ok: false });
    expect(await local({ action: "edit", path, edits: [{ oldText: "gamma", newText: "changed" }, { oldText: "amma", newText: "!" }] }, root)).toMatchObject({ ok: false });
    expect(readFileSync(join(root, path), "utf8")).toBe(before);
  });

  it("resolves shell cwd remotely, does not transmit local environment, and bounds output", async () => {
    const root = fixture();
    const result = await local({ action: "bash", cwd: root, command: "printf '%s\\n' \"$PWD\"; printf '%s' \"${PI_THREAD_TOKEN-unset}\"" }, root);
    expect(result).toMatchObject({ ok: true, value: { output: `${root}\nunset`, exitCode: 0 } });
    const large = await local({ action: "bash", command: "python3 -c 'print(\"x\" * 60000)'" }, root);
    expect(large).toMatchObject({ ok: true, value: { truncated: true } });
    if (large.ok) expect(Buffer.byteLength(String(large.value.output))).toBe(50 * 1024);
    await local({ action: "write", path: "lines", content: "one\ntwo\nthree\n" }, root);
    expect(await local({ action: "read", path: "lines", offset: 2, limit: 1 }, root)).toMatchObject({ ok: true, value: { text: "two\n", nextOffset: 3, truncated: true } });
  });

  it("kills command descendants on timeout, even after output was closed", async () => {
    const root = fixture(), pidFile = join(root, "pid");
    const result = await local({ action: "bash", cwd: root, command: "echo $$ > pid; exec >/dev/null 2>&1; exec sleep 30", timeout: 0.15 }, root);
    expect(result).toMatchObject({ ok: true, value: { stopped: "timeout", exitCode: -9 } });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("closes the connection on cancellation and the remote worker stops its command", async () => {
    const root = fixture(), pidFile = join(root, "pid"), controller = new AbortController();
    const pending = local({ action: "bash", cwd: root, command: "echo $$ > pid; exec sleep 30" }, root, controller.signal);
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects bad cwd and excessive timeout before SSH, and does not retry transport errors", async () => {
    let calls = 0;
    const launch = () => { calls++; return spawn("python3", ["-c", "import sys;sys.stderr.write('denied');sys.exit(255)"], { stdio: "pipe" }); };
    expect(await executeConverge({ action: "bash", command: "true", timeout: 56 }, { env, launch })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await executeConverge({ action: "read", cwd: "relative", path: "file" }, { env, launch })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(calls).toBe(0);
    expect(await executeConverge({ action: "bash", command: "true" }, { env, launch })).toMatchObject({ ok: false, error: { code: "transport", message: expect.stringContaining("inspect before retrying") } });
    expect(calls).toBe(1);
  });
});
