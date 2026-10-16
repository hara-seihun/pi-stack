import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSandboxTools } from "../src/threads/pi-sandbox.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Deliberately opt in: the configured public runtime and working namespaces are
// part of this behavior proof, not mocked filesystem prefix checks.
test.runIf(process.env.PI_SANDBOX_TEST === "1")("four upstream tools isolate files, env, processes, networking, and output spills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-test-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  await writeFile(join(root, "secret"), "host-private-sentinel");
  await symlink(join(root, "secret"), join(workspace, "host-link"));
  await symlink("/bin/sh", join(workspace, "runtime-link"));
  const previousSecret = process.env.PI_SANDBOX_PRIVATE_SENTINEL;
  process.env.PI_SANDBOX_PRIVATE_SENTINEL = "never-in-child";
  try {
    const definitions = await createSandboxTools(workspace);
    expect(definitions.map(tool => tool.name)).toEqual(["read", "write", "edit", "bash"]);
    const execute = (name: string, input: unknown, signal?: AbortSignal) => definitions.find(tool => tool.name === name)!.execute(
      "proof", input, signal, undefined, { cwd: root } as ExtensionContext,
    );
    await execute("write", { path: "nested/value.txt", content: "original" });
    await execute("edit", { path: "nested/value.txt", edits: [{ oldText: "original", newText: "changed" }] });
    expect(await readFile(join(workspace, "nested/value.txt"), "utf8")).toBe("changed");
    expect(JSON.stringify(await execute("read", { path: "nested/value.txt" }))).toContain("changed");
    await execute("write", { path: "~/home.txt", content: "workspace-home" });
    expect(await readFile(join(workspace, "home.txt"), "utf8")).toBe("workspace-home");
    for (const path of [join(root, "secret"), "../secret", "host-link", "runtime-link"]) {
      await expect(execute("read", { path })).rejects.toThrow();
    }
    await expect(execute("write", { path: "host-link", content: "overwritten" })).rejects.toThrow();
    await expect(execute("edit", { path: "host-link", edits: [{ oldText: "host", newText: "changed" }] })).rejects.toThrow();
    const shell = await execute("bash", { command: `test "$PWD" = /workspace && test "$HOME" = /workspace && test -z "$PI_SANDBOX_PRIVATE_SENTINEL" && test ! -e ${root}/secret && test ! -e /home && node -e 'const fs=require("fs"); const net=require("net"); if(fs.existsSync("/proc/${process.pid}")) process.exit(1); const s=net.connect(22,"127.0.0.1"); s.on("error",()=>console.log("isolated")); s.on("connect",()=>process.exit(1));'` });
    expect(JSON.stringify(shell)).toContain("isolated");
    const privateRequest = await execute("bash", { command: "curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/" });
    expect(JSON.stringify(privateRequest)).toContain("403");
    const beforeSpills = (await readdir(tmpdir())).filter(name => name.startsWith("pi-bash-"));
    const large = await execute("bash", { command: "node -e 'for(let i=0;i<3000;i++) console.log(\"line-\"+i)'" });
    const serialized = JSON.stringify(large);
    expect(serialized).toContain("line-2999");
    expect(serialized).toContain("/workspace/.pi-output-");
    expect((await readdir(tmpdir())).filter(name => name.startsWith("pi-bash-"))).toEqual(beforeSpills);
    const log = (await readdir(workspace)).find(name => name.startsWith(".pi-output-"))!;
    expect(await readFile(join(workspace, log), "utf8")).toContain("line-0\n");
    await expect(execute("bash", { command: "sleep 30", timeout: 0.1 })).rejects.toThrow("timed out");
    const abort = new AbortController();
    const running = execute("bash", { command: "sleep 30" }, abort.signal);
    setTimeout(() => abort.abort(), 100);
    await expect(running).rejects.toThrow("aborted");
  } finally {
    if (previousSecret === undefined) delete process.env.PI_SANDBOX_PRIVATE_SENTINEL;
    else process.env.PI_SANDBOX_PRIVATE_SENTINEL = previousSecret;
  }
}, 15_000);
