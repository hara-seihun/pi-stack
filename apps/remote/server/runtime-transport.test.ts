import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { attachRuntimeHost, runtimeSocketPath, startCommandRuntimeHost as startRuntimeHost, type RuntimeTransport } from "./runtime-transport";

const roots: string[] = [];
const transports: RuntimeTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.terminate()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime host identity", () => {
  test("cancelling startup reaps the detached host before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-cancel-"));
    roots.push(root);
    const controller = new AbortController();
    const starting = startRuntimeHost({ data: root, sessionId: "cancelled", cwd: root,
      args: [process.execPath, "-e", "setInterval(() => {}, 10000)"], env: process.env,
      signal: controller.signal, onOutput() {} });
    controller.abort(new Error("Startup cancelled"));
    await expect(starting).rejects.toThrow("Startup cancelled");
    expect(readdirSync(join(root, "runtime-hosts"))).toEqual([]);
  });
  test("handles termination between acquiring the spool and spawning the child", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-startup-signal-"));
    roots.push(root);
    const socketPath = join(root, "host.sock");
    const preload = join(root, "interrupt-startup.ts");
    const outputModule = join(import.meta.dir, "runtime-output.mjs");
    writeFileSync(preload, `
      import { mock } from "bun:test";
      import { RuntimeOutput } from ${JSON.stringify(outputModule)};
      mock.module(${JSON.stringify(outputModule)}, () => ({
        RuntimeOutput: class extends RuntimeOutput {
          constructor(path) {
            super(path);
            process.kill(process.pid, "SIGTERM");
          }
        },
      }));
    `);
    const host = Bun.spawn([process.execPath, "--preload", preload,
      join(import.meta.dir, "runtime-host.ts"), socketPath, root,
      Buffer.from(JSON.stringify([process.execPath, "-e", "setInterval(() => {}, 10000)"])).toString("base64url")],
    { stdout: "ignore", stderr: "inherit" });
    expect(await host.exited).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(socketPath + ".events")).toBe(false);
  });

  test("termination reaps the child and removes its files before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-terminate-"));
    roots.push(root);
    let reportPid!: (pid: number) => void;
    const output = new Promise<number>(resolve => { reportPid = resolve; });
    const host = await startRuntimeHost({ data: root, sessionId: "terminated", cwd: root,
      args: [process.execPath, "-e", "console.log(process.pid); setInterval(() => {}, 10000)"], env: process.env,
      onOutput(line) { reportPid(Number(line)); } });
    transports.push(host);
    const pid = await output;
    await host.terminate();
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readdirSync(join(root, "runtime-hosts"))).toEqual([]);
  });

  test("gives every launch its own socket even for the same thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-remote-runtime-"));
    roots.push(root);
    const child = join(root, "child.ts");
    writeFileSync(child, "await new Promise(() => {});\n");
    const options = {
      data: root,
      sessionId: "thread-1",
      cwd: root,
      args: [process.execPath, child],
      env: { ...process.env },
      onOutput: () => {},
    };

    const first = await startRuntimeHost(options);
    const second = await startRuntimeHost(options);
    transports.push(first, second);

    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.pid).not.toBe(second.pid);
    expect(existsSync(first.socketPath)).toBe(true);
    expect(existsSync(second.socketPath)).toBe(true);
  });

  test("reattaches across supervisor exit with full production-length identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-handoff-"));
    roots.push(root);
    const data = join(root, "private-folder", ".pi-remote");
    mkdirSync(data, { recursive: true });
    const launcher = join(root, "launcher.ts");
    writeFileSync(launcher, `
      import {startCommandRuntimeHost as startRuntimeHost} from ${JSON.stringify(join(import.meta.dir, "runtime-transport.ts"))};
      const host = await startRuntimeHost({ data: ${JSON.stringify(data)}, sessionId: crypto.randomUUID(), cwd: ${JSON.stringify(root)}, args: [process.execPath, "-e", "setInterval(() => {}, 10000)"], env: process.env, onOutput() {} });
      console.log(JSON.stringify({socketPath:host.socketPath,pid:host.pid}));
      host.detach();
      process.exit(75);
    `);
    const launcherProcess = Bun.spawn([process.execPath, launcher], { stdout: "pipe", stderr: "inherit" });
    const reader = launcherProcess.stdout.getReader();
    const output = await reader.read();
    const {socketPath, pid} = JSON.parse(new TextDecoder().decode(output.value).trim());
    await reader.cancel();
    expect(await launcherProcess.exited).toBe(75);
    const attached = await attachRuntimeHost(socketPath, () => {});
    transports.push(attached);
    expect(attached.pid).toBe(pid);
  });

  test("rejoins a shed shared socket without reporting exit or replaying commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-rejoin-"));
    roots.push(root);
    const path = join(root, "host.sock");
    const delivered: string[] = [];
    const commands: unknown[] = [];
    const cursors: number[] = [];
    const exits: number[] = [];
    const server = createServer(socket => {
      createInterface({ input: socket }).on("line", line => {
        const value = JSON.parse(line);
        if (value.type === "attach") {
          cursors.push(value.after);
          socket.write(JSON.stringify({ type: "attached", pid: process.pid, shared: true }) + "\n");
          if (cursors.length === 1) {
            socket.write(JSON.stringify({ type: "output", sequence: 1, line: "before image" }) + "\n");
          } else {
            socket.write(JSON.stringify({ type: "output", sequence: 1, line: "duplicate" }) + "\n");
            socket.write(JSON.stringify({ type: "output", sequence: 2, line: "retained image" }) + "\n");
          }
        } else if (value.type === "command") {
          commands.push(value.value);
          socket.write('{"type":"output","sequence":2,"line":"partial');
          setTimeout(() => socket.destroy(), 5);
        } else if (value.type === "terminate") {
          socket.end('{"type":"exit","code":0}\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const host = await attachRuntimeHost(path, line => delivered.push(line));
      transports.push(host);
      host.onExit(code => exits.push(code));
      host.send({ type: "prompt", message: "one paid request" });
      const deadline = Date.now() + 2000;
      while (delivered.length < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(cursors).toEqual([0, 1]);
      expect(delivered).toEqual(["before image", "retained image"]);
      expect(commands).toEqual([{ type: "prompt", message: "one paid request" }]);
      expect(exits).toEqual([]);
      await host.terminate();
      expect(exits).toEqual([0]);
      transports.splice(transports.indexOf(host), 1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("replaces an unresponsive connection without resending accepted commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-reconnect-"));
    roots.push(root);
    const path = join(root, "host.sock");
    const cursors: number[] = [];
    const commands: string[] = [];
    const delivered: string[] = [];
    const server = createServer(socket => {
      createInterface({ input: socket }).on("line", line => {
        const value = JSON.parse(line);
        if (value.type === "attach") {
          cursors.push(value.after);
          socket.write(JSON.stringify({type: "attached", pid: process.pid, shared: true}) + "\n");
          socket.write(JSON.stringify({type: "output", sequence: cursors.length, line: String(cursors.length)}) + "\n");
        } else if (value.type === "command") commands.push(value.value.type);
        else if (value.type === "terminate") socket.end('{"type":"exit","code":0}\n');
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const host = await attachRuntimeHost(path, line => delivered.push(line));
      transports.push(host);
      host.send({type: "prompt"});
      for (let i = 0; i < 100 && commands.length === 0; i++) await Bun.sleep(5);
      host.reconnect();
      for (let i = 0; i < 100 && delivered.length < 2; i++) await Bun.sleep(5);
      expect(cursors).toEqual([0, 1]);
      expect(delivered).toEqual(["1", "2"]);
      expect(commands).toEqual(["prompt"]);
      await host.terminate();
      transports.splice(transports.indexOf(host), 1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test("includes a launch identity in generated paths", () => {
    const first = runtimeSocketPath("/state", "thread", "first");
    const second = runtimeSocketPath("/state", "thread", "second");
    expect(first).toBe("/state/runtime-hosts/thread.first.sock");
    expect(second).toBe("/state/runtime-hosts/thread.second.sock");
  });
});
