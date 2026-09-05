import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function release(root, version) {
  const path = join(root, version);
  const extension = join(path, "extensions/browser");
  const dependencies = join(root, `dependencies-${version}`, "node_modules");
  mkdirSync(extension, { recursive: true });
  mkdirSync(join(dependencies, ".bin"), { recursive: true });
  mkdirSync(join(dependencies, "agent-browser"));
  const native = join(dependencies, "pi-agent-browser-native");
  mkdirSync(join(native, "dist/extensions/agent-browser"), { recursive: true });
  writeFileSync(join(native, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dependencies, "agent-browser/package.json"), JSON.stringify({ version }));
  writeFileSync(join(dependencies, ".bin/agent-browser"), `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
  writeFileSync(join(native, "dist/extensions/agent-browser/index.js"), `
    import { execFileSync } from "node:child_process";
    export default function (pi) {
      pi.registerTool({
        name: "agent_browser",
        execute() {
          return { wrapper: ${JSON.stringify(version)}, executable: execFileSync("agent-browser", ["--version"], { encoding: "utf8" }).trim() };
        },
      });
    }
  `);
  copyFileSync(new URL("index.mjs", import.meta.url), join(extension, "index.mjs"));
  symlinkSync(dependencies, join(path, "node_modules"));
  return path;
}

test("a running tool retains its pair after deployment; a new process selects the new pair", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-browser-release-"));
  const children = [];
  try {
    const first = release(root, "0.34.0");
    const second = release(root, "0.36.0");
    const selected = join(root, "runtime");
    symlinkSync(first, selected);
    const runner = join(root, "runner.mjs");
    writeFileSync(runner, `
      import { pathToFileURL } from "node:url";
      const { default: browser } = await import(pathToFileURL(process.argv[2]).href);
      let tool;
      await browser({ registerTool(value) { tool = value; } });
      process.on("message", () => process.send(tool.execute()));
      process.send(tool.execute());
    `);
    const start = () => {
      const child = fork(runner, [join(selected, "extensions/browser/index.mjs")], {
        env: { ...process.env, PATH: `${join(selected, "node_modules/.bin")}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      return child;
    };
    const running = start();
    assert.deepEqual((await once(running, "message"))[0], { wrapper: "0.34.0", executable: "0.34.0" });
    symlinkSync(second, `${selected}.next`);
    renameSync(`${selected}.next`, selected);
    const continued = once(running, "message");
    running.send("run");
    assert.deepEqual((await continued)[0], { wrapper: "0.34.0", executable: "0.34.0" });
    const fresh = start();
    assert.deepEqual((await once(fresh, "message"))[0], { wrapper: "0.36.0", executable: "0.36.0" });
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }));
    rmSync(root, { recursive: true, force: true });
  }
});
