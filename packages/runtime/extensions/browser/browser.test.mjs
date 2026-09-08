import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
const runtimeEntry = process.env.PI_TEST_RUNTIME_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, RpcClient, SessionManager, SettingsManager } = await import(runtimeEntry);

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
    const probe = () => ({ wrapper: ${JSON.stringify(version)}, executable: execFileSync("agent-browser", ["--version"], { encoding: "utf8" }).trim() });
    export default function (pi) {
      pi.registerTool({
        name: "agent_browser", label: "Browser", description: "Release probe",
        parameters: { type: "object", properties: {} },
        execute() { return { content: [], details: probe() }; },
      });
      pi.registerCommand("browser-probe", {
        handler: async (args, ctx) => {
          if (args === "reload") { await ctx.reload(); return; }
          pi.appendEntry("browser-probe", probe());
        },
      });
    }
  `);
  copyFileSync(new URL("package.json", import.meta.url), join(extension, "package.json"));
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
      await browser({ registerTool(value) { tool = value; }, registerCommand() {} });
      process.on("message", () => process.send(tool.execute().details));
      process.send(tool.execute().details);
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

test("Pi reload selects both dependencies again after a release switch and rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-browser-reload-"));
  const path = process.env.PATH;
  try {
    const first = release(root, "0.34.0");
    const second = release(root, "0.36.0");
    const selected = join(root, "runtime");
    symlinkSync(first, selected);
    const settingsManager = SettingsManager.inMemory({ packages: [join(selected, "extensions/browser")] });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload({ resolveProjectTrust: async () => true });
    const { session } = await createAgentSession({
      cwd: root, agentDir: join(root, "agent"), resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.inMemory(root),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      const probe = async () => {
        assert.deepEqual(loader.getExtensions().errors, []);
        const tools = session.agent.state.tools.filter((tool) => tool.name === "agent_browser");
        assert.equal(tools.length, 1);
        return (await tools[0].execute("probe", {})).details;
      };
      assert.deepEqual(await probe(), { wrapper: "0.34.0", executable: "0.34.0" });
      symlinkSync(second, `${selected}.next`);
      renameSync(`${selected}.next`, selected);
      assert.deepEqual(await probe(), { wrapper: "0.34.0", executable: "0.34.0" });
      await session.reload();
      assert.deepEqual(await probe(), { wrapper: "0.36.0", executable: "0.36.0" });
      symlinkSync(first, `${selected}.next`);
      renameSync(`${selected}.next`, selected);
      await session.reload();
      assert.deepEqual(await probe(), { wrapper: "0.34.0", executable: "0.34.0" });
    } finally {
      session.dispose();
    }
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the stack doctor rejects missing and duplicate native sources without recommending npm installation", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-browser-doctor-"));
  try {
    const runtime = release(root, "0.36.0");
    const scope = join(runtime, "node_modules/@earendil-works");
    mkdirSync(scope);
    symlinkSync(dirname(dirname(fileURLToPath(runtimeEntry))), join(scope, "pi-coding-agent"));
    const agentDir = join(root, ".pi/agent");
    mkdirSync(agentDir, { recursive: true });
    for (const packages of [[], [join(runtime, "extensions/browser"), join(runtime, "node_modules/pi-agent-browser-native/dist/extensions/agent-browser/index.js")]]) {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../browser-doctor.mjs", import.meta.url))], {
        cwd: root, encoding: "utf8", timeout: 10000,
        env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_STACK_RUNTIME_DEST: runtime },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /restore exactly one browser entrypoint with the host's pi-stack-release command, not pi install npm/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled RPC reloads the selected pair without restarting the process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-browser-rpc-"));
  let client;
  try {
    const first = release(root, "0.34.0");
    const second = release(root, "0.36.0");
    const selected = join(root, "runtime");
    symlinkSync(first, selected);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [join(selected, "extensions/browser")] }));
    client = new RpcClient({
      cliPath: fileURLToPath(new URL("bundle/cli.js", runtimeEntry)), cwd: root,
      env: { PI_CODING_AGENT_DIR: agentDir },
      args: ["--offline", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session"],
    });
    await client.start();
    const probe = async () => {
      await client.prompt("/browser-probe");
      const { entries } = await client.getEntries();
      return entries.filter((entry) => entry.type === "custom" && entry.customType === "browser-probe").at(-1).data;
    };
    assert.deepEqual(await probe(), { wrapper: "0.34.0", executable: "0.34.0" });
    for (const [releasePath, version] of [[second, "0.36.0"], [first, "0.34.0"]]) {
      symlinkSync(releasePath, `${selected}.next`);
      renameSync(`${selected}.next`, selected);
      await client.prompt("/browser-probe reload");
      assert.deepEqual(await probe(), { wrapper: version, executable: version });
    }
  } finally {
    await client?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
