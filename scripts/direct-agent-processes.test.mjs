import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { directAgentProcessProof } from "../deploy/direct-agent-processes.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "direct-process-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const process = (pid, parent, start, args) => {
    const path = join(root, String(pid)); mkdirSync(path);
    const stat = Array(20).fill("0"); stat[0] = "S"; stat[1] = String(parent); stat[19] = start;
    writeFileSync(join(path, "stat"), `${pid} (node) ${stat.join(" ")}`);
    writeFileSync(join(path, "cmdline"), args.join("\0"));
  };
  return { root, process };
}
test("retained direct custody matches exact process start identity and covers native CLI descendants", t => {
  const f = fixture(t);
  f.process(101, 1, "100", ["node", "/srv/pi/runtime/stack-agent.mjs"]);
  f.process(102, 101, "101", ["node", "/srv/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]);
  f.process(103, 1, "102", ["node", "/srv/pi/runtime/browser-doctor.mjs"]);
  const retained = { version: 1, processes: [{ pid: 101, processStart: "100", ownerId: "host/alice", agentId: "agent", executionId: "execution" }] };
  const proof = directAgentProcessProof(f.root, retained, 0);
  assert.deepEqual(proof.oldProcesses, [{ pid: 103, processStart: "102" }]);
  assert.equal(proof.retainedProcesses.length, 2);
  assert.ok(proof.retainedProcesses.every(row => row.custodyPid === 101 && row.executionId === "execution"));
  retained.processes[0].processStart = "reused-pid";
  assert.equal(directAgentProcessProof(f.root, retained, 0).oldProcesses.length, 3);
});
test("only the independently verified root PID is excluded; an old SDK root still holds cutover", t => {
  const f = fixture(t);
  f.process(201, 1, "100", ["bun", "/srv/pi/remote/kenan-root/src/main.ts"]);
  f.process(202, 1, "101", ["bun", "/srv/pi/earlier/kenan-root/src/main.ts"]);
  const proof = directAgentProcessProof(f.root, { version: 1, processes: [] }, 201);
  assert.deepEqual(proof.oldProcesses, [{ pid: 202, processStart: "101" }]);
});
test("source searches and file copies are not SDK agents; inline native SDK evaluation is", t => {
  const f = fixture(t);
  f.process(401, 1, "100", ["rg", "createAgentSession", "/srv/pi/runtime/browser-doctor.mjs"]);
  f.process(402, 1, "101", ["cp", "/srv/pi/runtime/stack-pi.mjs", "/target"]);
  f.process(403, 1, "102", ["node", "--input-type=module", "-e", "const session = await createAgentSession({})"]);
  assert.deepEqual(directAgentProcessProof(f.root, { version: 1, processes: [] }, 0).oldProcesses, [{ pid: 403, processStart: "102" }]);
});

test("unset retention and missing process evidence are errors rather than complete empty coverage", t => {
  const f = fixture(t);
  assert.throws(() => directAgentProcessProof(f.root, undefined, 0), /receipt is required/);
  mkdirSync(join(f.root, "301")); writeFileSync(join(f.root, "301/stat"), "invalid");
  assert.throws(() => directAgentProcessProof(f.root, { version: 1, processes: [] }, 0), /census unavailable/);
});
