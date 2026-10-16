import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
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

/** Real namespace/proxy proof. The fixture gateway fixes policy on the host; real provider acceptance belongs to the harness. */
export async function runBenchmarkSandboxAcceptance(): Promise<{ ok: true; assertions: string[]; elapsedMs: number }> {
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), "pi-benchmark-acceptance-"));
  const previousConfig = process.env.PI_SANDBOX_RUNTIME_CONFIG;
  const assertions: string[] = [];
  const gateway = createServer((incoming, outgoing) => {
    incoming.resume();
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.end(JSON.stringify({ asOf: "2024-01-01", command: incoming.url, content: "pre-cutoff fixture" }));
  });
  try {
    const workspace = join(root, "workspace"), gatewayRoot = join(root, "gateways");
    await mkdir(workspace); await mkdir(gatewayRoot);
    const socketPath = join(gatewayRoot, "case.sock");
    await new Promise<void>(resolve => gateway.listen(socketPath, resolve));
    const runtime = JSON.parse(await readFile(previousConfig ?? "/etc/pi-stack/sandbox-runtime.json", "utf8"));
    const config = join(root, "runtime.json");
    await writeFile(config, JSON.stringify({ ...runtime, gatewayRoot }));
    process.env.PI_SANDBOX_RUNTIME_CONFIG = config;
    const tools = await createSandboxTools(workspace, { profile: "benchmark", gatewaySocket: socketPath });
    const bash = tools.find(tool => tool.name === "bash")!;
    const checks: [string, string][] = [
      ["live HTTPS denied", "! curl -fsS --max-time 2 https://example.com"],
      ["Parallel denied", "! curl -fsS --max-time 2 https://api.parallel.ai/v1/search"],
      ["Exa denied", "! curl -fsS --max-time 2 https://api.exa.ai/search"],
      ["HTTP denied", "test \"$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://example.com)\" = 403"],
      ["direct IP route absent", "! curl --noproxy '*' -fsS --max-time 2 http://1.1.1.1"],
      ["arbitrary DNS unavailable", "python3 -c 'import socket; socket.setdefaulttimeout(2);\ntry: socket.getaddrinfo(\"example.com\",443)\nexcept OSError: print(\"dns-denied\")\nelse: raise SystemExit(1)'"],
      ["no workspace keys or host gateway socket", `test ! -e /workspace/.config/web-keys.json && test ! -e '${socketPath}' && test -z \"\${PARALLEL_API_KEY-}\${EXA_API_KEY-}\"`],
      ["gateway search and read, cutoff cannot be overridden", "python3 -c 'import json,urllib.request;\nfor op in [\"search\",\"read\"]:\n r=urllib.request.Request(\"http://research.gateway/\"+op,data=json.dumps({\"asOf\":\"2099-01-01\"}).encode(),headers={\"Content-Type\":\"application/json\"}); v=json.load(urllib.request.urlopen(r)); assert v[\"asOf\"]==\"2024-01-01\" and v[\"command\"]==\"/\"+op'"],
    ];
    for (const [name, command] of checks) {
      const result = await bash.execute("benchmark-proof", { command: `${command} && printf '\\nbenchmark-check-ok\\n'`, timeout: 5 }, undefined, undefined, { cwd: root } as ExtensionContext);
      if (!JSON.stringify(result).includes("benchmark-check-ok")) throw new Error(`Benchmark sandbox acceptance failed: ${name}: ${JSON.stringify(result)}`);
      assertions.push(name);
    }
    return { ok: true, assertions, elapsedMs: Date.now() - started };
  } finally {
    if (previousConfig === undefined) delete process.env.PI_SANDBOX_RUNTIME_CONFIG;
    else process.env.PI_SANDBOX_RUNTIME_CONFIG = previousConfig;
    if (gateway.listening) await new Promise<void>(resolve => gateway.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
