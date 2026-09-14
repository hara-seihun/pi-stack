import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";
import { buildSync } from "esbuild";
import { describe, expect, test } from "vitest";
import { assertWorkerExecution } from "../src/host/worker-execution.js";
import { sharedOwner } from "../src/shared-custody.js";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";

const ownerEnv = { HOME: "/home/kenan", PI_CODING_AGENT_DIR: "/home/kenan/.pi/agent", PI_ORCHESTRATOR_AUTH: "/shared/auth.json",
  PI_ORCHESTRATOR_CONFIG: "/home/kenan/.config/pi-orchestrator/config.json", PI_ORCHESTRATOR_LEDGER: "/shared/ledger.sqlite3", PI_ORCHESTRATOR_OWNER_UID: "1000", PI_ORCHESTRATOR_OWNER_GID: "100" };

describe("worker execution contract", () => {
  test("requires root only for root repair, with full explicit shared context", () => {
    expect(() => assertWorkerExecution({ execution: "root-repair" }, ownerEnv, 0)).not.toThrow();
    expect(() => assertWorkerExecution({ execution: "root-repair" }, ownerEnv, 1000)).toThrow("requires uid 0");
    for (const execution of [undefined, "user"] as const) expect(() => assertWorkerExecution({ execution }, ownerEnv, 0)).toThrow("Ordinary workers");
    expect(() => assertWorkerExecution({ execution: "root-repair", context: { tools: [] } }, ownerEnv, 0)).toThrow("full normal Pi context");
    for (const key of Object.keys(ownerEnv)) {
      const env = { ...ownerEnv } as NodeJS.ProcessEnv;
      delete env[key];
      expect(() => assertWorkerExecution({ execution: "root-repair" }, env, 0)).toThrow();
    }
    expect(() => assertWorkerExecution({ execution: "user" }, {}, 1000)).not.toThrow();
  });
  test("refuses malformed custody instead of stranding new root files", () => {
    for (const uid of ["", "0", "-1", "1.5", "1000junk", "4294967295"]) {
      expect(() => sharedOwner({ ...ownerEnv, PI_ORCHESTRATOR_OWNER_UID: uid }, 0)).toThrow();
    }
    expect(sharedOwner(ownerEnv, 1000)).toBeUndefined();
  });
});

test.skipIf(process.env.PI_TEST_ROOT_CUSTODY !== "1")("real uid 0 session, settings and OAuth writes stay in daemon custody", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-root-custody-"));
  const source = resolve("src");
  const sdk = join(getPackageDir(), "dist");
  const env = { ...ownerEnv, PI_ORCHESTRATOR_OWNER_UID: String(process.getuid!()), PI_ORCHESTRATOR_OWNER_GID: String(process.getgid!()),
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_ORCHESTRATOR_AUTH: join(root, "shared/auth.json"), PI_ORCHESTRATOR_LEDGER: join(root, "shared/ledger.sqlite3") };
  const probe = join(root, "probe.mjs");
  const ledgerPath = join(root, "ledger.sqlite3");
  const ledger = new DatabaseSync(ledgerPath);
  ledger.exec("CREATE TABLE custody (writer TEXT); INSERT INTO custody VALUES ('owner')");
  ledger.close();
  const bundle = readdirSync(join(sdk, "bundle/chunks")).map(name => join(sdk, "bundle/chunks", name))
    .find(path => path.endsWith(".js") && readFileSync(path, "utf8").includes("var SessionManager=class _SessionManager"))!;
  try {
    const script = `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { DatabaseSync } from 'node:sqlite';
      import { statSync } from 'node:fs';
      import { join } from 'node:path';
      import { CoreJournal, writeCoreState } from ${JSON.stringify(join(source, "cores/journal.ts"))};
      import { writePiState } from ${JSON.stringify(join(source, "cores/pi-store.ts"))};
      import { SharedOAuthAuth } from ${JSON.stringify(join(source, "auth/shared-oauth.ts"))};
      Object.assign(process.env, ${JSON.stringify(env)});
      assert.equal(process.getuid(), 0);
      const root = ${JSON.stringify(root)};
      const owner = Number(process.env.PI_ORCHESTRATOR_OWNER_UID);
      const stateDir = join(root, 'runs/root/children/child');
      const journal = new CoreJournal(stateDir, 'pi', 'child', root);
      journal.record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'saved' }], timestamp: 1 } });
      journal.close();
      writeCoreState(join(stateDir, 'state.json'), { value: 1 });
      writeCoreState(join(stateDir, 'state.json'), { value: 2 });
      writePiState(join(stateDir, 'tree.json'), '{}');
      writePiState(join(stateDir, 'tree.json'), '{"saved":true}');
      const { SessionManager, createBashTool } = await import(${JSON.stringify(join(sdk, "index.js"))});
      const session = SessionManager.create(root, join(root, 'native/deep'));
      session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved' }], api: 'openai-responses', provider: 'test', model: 'test', usage: {}, stopReason: 'stop', timestamp: Date.now() });
      session._rewriteFile();
      session.appendMessage({ role: 'user', content: 'still writable', timestamp: Date.now() });
      const { FileSettingsStorage } = await import(${JSON.stringify(join(sdk, "core/settings-manager.js"))});
      const settings = new FileSettingsStorage(root, process.env.PI_CODING_AGENT_DIR);
      settings.withLock('global', () => '{"revision":1}');
      settings.withLock('global', () => {
        assert.equal(statSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json.lock')).uid, owner);
        return '{"revision":2}';
      });
      const { FileAuthStorageBackend } = await import(${JSON.stringify(join(sdk, "core/auth-storage.js"))});
      const nativeAuth = new FileAuthStorageBackend(join(process.env.PI_CODING_AGENT_DIR, 'native-auth.json'));
      await nativeAuth.withLockAsync(() => {
        assert.equal(statSync(nativeAuth.authPath + '.lock').uid, owner);
        return { result: undefined, next: '{}' };
      });
      const auth = new SharedOAuthAuth({ path: process.env.PI_ORCHESTRATOR_AUTH, providerId: 'test', toAuth: c => ({ apiKey: c.access }), refresh: async c => {
        assert.equal(statSync(process.env.PI_ORCHESTRATOR_AUTH + '.lock').uid, owner);
        return { ...c, access: 'root-refreshed', expires: 0 };
      } });
      await auth.set('test', { type: 'oauth', access: 'initial', refresh: 'refresh', expires: 0 });
      await auth.credential('test', new AbortController().signal);
      const bundled = await import(${JSON.stringify(bundle)});
      const bundledSession = bundled.SessionManager.create(root, join(root, 'bundled/native/deep'));
      bundledSession.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved' }], api: 'openai-responses', provider: 'test', model: 'test', usage: {}, stopReason: 'stop', timestamp: Date.now() });
      bundledSession._rewriteFile();
      const bundledSettings = bundled.SettingsManager.create(root, join(root, 'bundled/agent'));
      bundledSettings.setTheme('dark');
      await bundledSettings.flush();
      bundledSettings.setTheme('light');
      await bundledSettings.flush();
      assert.deepEqual(bundledSettings.drainErrors(), []);
      const ledgerPath = ${JSON.stringify(ledgerPath)};
      const ledger = new DatabaseSync(ledgerPath);
      ledger.exec("PRAGMA journal_mode=WAL; INSERT INTO custody VALUES ('root')");
      for (const path of [ledgerPath + '-wal', ledgerPath + '-shm']) assert.equal(statSync(path).uid, owner);
      execFileSync(process.execPath, ['--input-type=module', '-e', 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(' + JSON.stringify(ledgerPath) + '); db.exec("INSERT INTO custody VALUES (\\\'reopened-owner\\\')"); db.close();'],
        { uid: owner, gid: Number(process.env.PI_ORCHESTRATOR_OWNER_GID), timeout: 5000 });
      ledger.close();
      const bash = createBashTool(root);
      const result = await bash.execute('root-proof', { command: 'test "$(id -u)" = 0 && test "$HOME" = /home/kenan && printf root-tool', timeout: 5 });
      assert.match(JSON.stringify(result), /root-tool/);
      console.log(JSON.stringify({ sessionFile: session.getSessionFile() }));
    `;
    const built = buildSync({ stdin: { contents: script, resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", write: false,
      external: [`${sdk}/*`] });
    writeFileSync(probe, built.outputFiles[0].text);
    const output = execFileSync("sudo", ["-n", process.execPath, probe], { encoding: "utf8", timeout: 20_000 });
    const { sessionFile } = JSON.parse(output.trim());
    const inspect = (path: string) => {
      const stat = statSync(path);
      expect(stat.uid, path).toBe(process.getuid!());
      expect(stat.gid, path).toBe(process.getgid!());
      accessSync(path, constants.R_OK | constants.W_OK);
      if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
    };
    inspect(root);
    for (const path of [sessionFile, join(root, "agent/settings.json"), join(root, "bundled/agent/settings.json"), join(root, "runs/root/children/child/state.json"), join(root, "runs/root/children/child/tree.json")]) {
      expect(statSync(path).mode & 0o777, path).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(join(root, "agent/settings.json"), "utf8"))).toEqual({ revision: 2 });
    writeFileSync(sessionFile, "\n", { flag: "a" });
    const reopened = new DatabaseSync(ledgerPath);
    try { expect(reopened.prepare("SELECT writer FROM custody").all().map(row => row.writer)).toEqual(["owner", "root", "reopened-owner"]); }
    finally { reopened.close(); }
    const auth = new SharedOAuthAuth({ path: env.PI_ORCHESTRATOR_AUTH, providerId: "test", toAuth: async c => ({ apiKey: c.access }),
      refresh: async credential => ({ ...credential, access: "owner-refreshed", expires: Date.now() + 600_000 }) });
    expect((await auth.credential("test", new AbortController().signal)).access).toBe("owner-refreshed");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
