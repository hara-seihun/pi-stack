import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { terminalLaunch } from "./stack-pi.mjs";
import { nativeHostLaunch } from "./native-guardian.mjs";
import { assertNativeOrigin, nativeExitCode, nativeManagerEnvironment, nativeOrigin } from "./native-recovery.mjs";
import { managedCliSource } from "./patch-managed-cli.mjs";

test("terminal scopes inherit real IO/namespace and keep credentials out of manager arguments", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-terminal-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = ["--mode", "rpc", "--api-key", "fixture-secret"];
  const launch = terminalLaunch(args, dir);
  assert.ok(launch.args.includes("--scope"));
  assert.equal(launch.args.some(arg => ["--pty", "--pipe", "--wait"].includes(arg)), false);
  assert.ok(launch.args.includes("--property=KillMode=control-group"));
  assert.equal(launch.args.some(arg => /EnvironmentFile|WorkingDirectory|ExecStopPost/.test(arg)), false);
  assert.equal(launch.args.join(" ").includes("fixture-secret"), false);
  const manifest = JSON.parse(readFileSync(launch.manifest, "utf8"));
  assert.deepEqual(manifest.args, args);
  assert.deepEqual(manifest.origin, nativeOrigin());
  assert.equal(statSync(launch.manifest).mode & 0o777, 0o600);
  const native = nativeHostLaunch(manifest, launch.manifest);
  assert.ok(native.includes("--scope"));
  assert.ok(native.includes(`--property=BindsTo=${launch.guardian}`));
  assert.ok(native.includes(`--property=After=${launch.guardian}`));
  assert.ok(native.includes(`--unit=${launch.unit}`));
  assert.equal(native.join(" ").includes("fixture-secret"), false);
  assert.throws(() => nativeHostLaunch({ ...manifest, guardian: "another-owner.scope" }, launch.manifest), /Invalid managed terminal scope/);
  launch.cleanup();
});

test("only the kernel UID selects the manager bus, preserving other application environment", () => {
  const env = nativeManagerEnvironment({ XDG_RUNTIME_DIR: "/run/user/0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus", HOME: "/private/app/home", TOKEN: "fixture" }, 1234);
  assert.deepEqual(env, { XDG_RUNTIME_DIR: "/run/user/1234", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus", HOME: "/private/app/home", TOKEN: "fixture" });
});

test("namespace or account changes fail before native execution", () => {
  const origin = nativeOrigin();
  assert.doesNotThrow(() => assertNativeOrigin(origin));
  for (const key of ["uid", "gid", "mount", "user", "cwd"]) {
    assert.throws(() => assertNativeOrigin({ ...origin, [key]: typeof origin[key] === "number" ? origin[key] + 1 : "different" }), { code: "native_boundary_changed" });
  }
});

test("native exit status preserves signal identity and rejects an unknown outcome", () => {
  assert.equal(nativeExitCode(7, null), 7);
  assert.equal(nativeExitCode(null, "SIGKILL"), 137);
  assert.equal(nativeExitCode(null, "SIGINT"), 130);
  assert.throws(() => nativeExitCode(null, null), { code: "native_exit_unknown" });
});

test("managed CLI factory patch owns initial and replacement sessions, fails changed upstream anchors", () => {
  const source = `const created = await createAgentSessionFromServices({\n            customTools: sessionOptions.customTools,\n        });`;
  const managed = managedCliSource(source);
  assert.match(managed, /createManagedAgentSession\(\(\) => createAgentSessionFromServices/);
  assert.equal(managedCliSource(managed), managed);
  const eager = 'import { createManagedAgentSession } from "../../../../managed-agent.mjs"; // PiStack native ThreadService owner\n' + source.replace('const created = await createAgentSessionFromServices({', 'const created = await createManagedAgentSession(() => createAgentSessionFromServices({').replace('        });', '        }), { cwd });');
  assert.equal(managedCliSource(eager), managed);
  assert.throws(() => managedCliSource("changed upstream"), /no longer matches Pi/);
});

test("SDK barrel and managed owner load in either order without a CLI-owner import cycle", t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-managed-cli-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'node_modules/@earendil-works/pi-coding-agent/dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(dist, '../package.json'), JSON.stringify({ type: 'module', exports: './dist/index.js' }));
  writeFileSync(join(dist, 'index.js'), 'export { main } from "./main.js"; export const sdkReady = true;');
  writeFileSync(join(dir, 'managed-agent.mjs'), readFileSync(new URL('./managed-agent.mjs', import.meta.url)));
  mkdirSync(join(dir, 'capacity'));
  writeFileSync(join(dir, 'capacity/native-session.js'), `import { sdkReady } from '@earendil-works/pi-coding-agent';
export let owned = 0;
export async function createManagedAgentSession(factory) { if (!sdkReady) throw Error('SDK unavailable'); owned++; return factory(); }
export function recoverNativeSessionOwners() {}`);
  const upstream = `export async function main(help = false) {
if (help) return 'help';
const cwd = '/fixture', sessionOptions = { customTools: [] };
const createAgentSessionFromServices = async () => ({ session: {} });
const created = await createAgentSessionFromServices({
            customTools: sessionOptions.customTools,
        });
return created;
}`;
  writeFileSync(join(dist, 'main.js'), managedCliSource(upstream));
  for (const first of ['sdk', 'owner']) {
    const code = `const paths = { sdk: './node_modules/@earendil-works/pi-coding-agent/dist/index.js', owner: './managed-agent.mjs' };
await import(paths['${first}']);
const { main } = await import(paths.sdk);
if (await main(true) !== 'help') throw Error('help failed');
const owner = await import('./capacity/native-session.js');
if (owner.owned !== 0) throw Error('help created session');
await main(); await main();
if (owner.owned !== 2) throw Error('session escaped ownership');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, `${first}: ${result.stderr}`);
  }
});
