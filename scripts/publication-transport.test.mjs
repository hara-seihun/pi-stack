import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

const isolated = ["-o", "ControlPath=none", "-o", "ControlMaster=no", "-o", "ControlPersist=no"];

test("publication commands own their SSH transport, stdin and failure status", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = `#!${process.execPath}
let input = "";
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ args: process.argv.slice(2), input }));
console.error("transport diagnostic");
process.exit(Number(process.env.TRANSPORT_STATUS ?? 0));
`;
  for (const command of ["ssh", "rsync", "bash"]) writeFileSync(join(bin, command), stub, { mode: 0o700 });
  const config = publicationConfig(root);
  function run(command, args, input, status = 0) {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { commandResult } from ${JSON.stringify(new URL("../deploy/publication", import.meta.url).href)};
      console.log(JSON.stringify(commandResult(${JSON.stringify(command)}, ${JSON.stringify(args)},
        { input: ${JSON.stringify(input)}, timeoutSeconds: 2 })));
    `], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      PATH: `${bin}:${process.env.PATH}`, PI_STACK_PUBLICATION_CONFIG: config, TRANSPORT_STATUS: String(status) } });
    assert.equal(probe.status, 0, probe.error?.message ?? probe.stderr);
    return JSON.parse(probe.stdout);
  }
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "fixture-host", "bash", "-s", "--", "release"];
  const input = "printf 'release proof\\n'\n";
  let result = run("ssh", args, input);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), { args: [...isolated, ...args], input });
  assert.equal(result.stderr, "transport diagnostic\n");

  const transfer = ["-a", "--chmod=D700,F600", "/fixture/artifact/", "fixture-host:/fixture/transfer/"];
  result = run("rsync", transfer, "");
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout).args, ["-e", ["ssh", ...isolated, "-o", "BatchMode=yes"].join(" "), ...transfer]);

  result = run("ssh", args, input, 255);
  assert.equal(result.ok, false);
  assert.equal(result.status, 255);
  assert.equal(result.stderr, "transport diagnostic\n");
  result = run("bash", ["-s"], input);
  assert.deepEqual(JSON.parse(result.stdout), { args: ["-s"], input });
});
