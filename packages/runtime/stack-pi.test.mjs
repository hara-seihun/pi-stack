import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { terminalLaunch } from "./stack-pi.mjs";
import { managedCliSource } from "./patch-managed-cli.mjs";

test("terminal launcher only attaches IO to an owned native host and keeps secrets out of argv", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-terminal-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = ["--mode", "rpc", "--api-key", "fixture-secret"], env = { HOME: dir, TOKEN: 'private "fixture"\\token' };
  const pipe = terminalLaunch(args, env, dir, false);
  assert.ok(pipe.args.includes("--pipe"));
  assert.ok(pipe.args.includes("--wait"));
  assert.ok(pipe.args.includes("--property=KillMode=control-group"));
  const stop = pipe.args.find(arg => arg.startsWith("--property=ExecStopPost="));
  assert.ok(stop.includes("native-recovery.mjs"));
  assert.ok(stop.includes(`--property=After=${pipe.unit}`));
  assert.ok(stop.includes("--property=Restart=on-failure"));
  assert.equal(pipe.args.join(" ").includes("fixture-secret"), false);
  assert.equal(pipe.args.join(" ").includes("private"), false);
  assert.deepEqual(JSON.parse(readFileSync(pipe.manifest, "utf8")).args, args);
  assert.equal(statSync(pipe.manifest).mode & 0o777, 0o600);
  assert.equal(statSync(pipe.environment).mode & 0o777, 0o600);
  assert.match(readFileSync(pipe.environment, "utf8"), /TOKEN="private \\"fixture\\"\\\\token"/);
  pipe.cleanup(true);
  const tty = terminalLaunch([], env, dir, true);
  assert.ok(tty.args.includes("--pty"));
  tty.cleanup(true);
});

test("managed CLI factory patch owns initial and replacement sessions, fails changed upstream anchors", () => {
  const source = `const created = await createAgentSessionFromServices({\n            customTools: sessionOptions.customTools,\n        });`;
  const managed = managedCliSource(source);
  assert.match(managed, /createManagedAgentSession\(\(\) => createAgentSessionFromServices/);
  assert.equal(managedCliSource(managed), managed);
  assert.throws(() => managedCliSource("changed upstream"), /no longer matches Pi/);
});
