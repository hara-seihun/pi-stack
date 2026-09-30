import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSandboxTools } from "./pi-sandbox.js";

/** Deployed-module acceptance, with no model request or retained test state. */
export async function runSandboxAcceptance(): Promise<{ ok: true; tools: string[]; assertions: number; elapsedMs: number }> {
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-acceptance-"));
  const workspace = join(root, "workspace");
  const sentinel = "PI_SANDBOX_ACCEPTANCE_SECRET";
  const previous = process.env[sentinel];
  let assertions = 0;
  function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(`Sandbox acceptance failed: ${message}`);
    assertions++;
  }
  try {
    process.env[sentinel] = "host-only-sentinel";
    await mkdir(workspace);
    await writeFile(join(root, "host-only.txt"), "outside-workspace");
    await symlink(join(root, "host-only.txt"), join(workspace, "host-link"));
    const tools = await createSandboxTools(workspace);
    const context = { cwd: root } as ExtensionContext;
    const execute = (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute("acceptance", input, undefined, undefined, context);
    await execute("write", { path: "nested/test.txt", content: "before" });
    await execute("edit", { path: "nested/test.txt", edits: [{ oldText: "before", newText: "after" }] });
    assert(await readFile(join(workspace, "nested/test.txt"), "utf8") === "after", "write/edit did not persist to the workspace");
    assert(JSON.stringify(await execute("read", { path: "nested/test.txt" })).includes("after"), "read failed");
    for (const path of [join(root, "host-only.txt"), "../host-only.txt", "host-link"]) {
      let refused = false;
      try { await execute("read", { path }); } catch { refused = true; }
      assert(refused, `read escaped through ${path}`);
    }
    let refusedWrite = false;
    try { await execute("write", { path: "host-link", content: "escape" }); } catch { refusedWrite = true; }
    assert(refusedWrite, "write followed an external symlink");
    assert(await readFile(join(root, "host-only.txt"), "utf8") === "outside-workspace", "outside file was modified");
    await execute("write", { path: "local-package/package.json", content: JSON.stringify({ name: "sandbox-local-proof", version: "1.0.0", main: "index.js" }) });
    await execute("write", { path: "local-package/index.js", content: "module.exports = 42;" });
    const shell = await execute("bash", { command: [
      "set -eu",
      `test "$PWD" = /workspace && test "$HOME" = /workspace && test -z "\${${sentinel}-}"`,
      `test ! -e '${root}/host-only.txt' && test ! -e /proc/${process.pid}`,
      "test \"$(curl --max-time 3 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/)\" = 403",
      "npm install --ignore-scripts --no-audit --no-fund ./local-package is-number@7.0.0",
      "node -e 'if(require(\"sandbox-local-proof\")!==42 || !require(\"is-number\")(42)) process.exit(1)'",
      "python3 -m venv .venv && .venv/bin/pip install --disable-pip-version-check --no-deps six==1.17.0",
      ".venv/bin/python -c 'import six; assert six.__version__ == \"1.17.0\"'",
      "printf 'sandbox-downloads-and-boundaries-ok\\n'",
    ].join("\n"), timeout: 30 });
    assert(JSON.stringify(shell).includes("sandbox-downloads-and-boundaries-ok"), "shell, isolation or package download/install failed");
    return { ok: true, tools: tools.map(tool => tool.name), assertions, elapsedMs: Date.now() - started };
  } finally {
    if (previous === undefined) delete process.env[sentinel];
    else process.env[sentinel] = previous;
    await rm(root, { recursive: true, force: true });
  }
}
