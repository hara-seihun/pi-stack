import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { identifyRunnerFactory, loadRunnerFactory } from "../src/threads/runner-factory.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-load-")); roots.push(root);
  const commit = "a".repeat(40), release = join(root, commit), entry = join(release, "dist/threads/pi-session.js");
  const sdk = join(release, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(join(release, "dist/threads"), { recursive: true }); mkdirSync(join(sdk, "dist"), { recursive: true });
  writeFileSync(join(release, "package.json"), '{"type":"module"}');
  writeFileSync(join(release, ".pi-stack-commit"), commit);
  writeFileSync(join(sdk, "package.json"), '{"name":"@earendil-works/pi-coding-agent","type":"module","main":"dist/index.js","exports":{".":{"import":"./dist/index.js"}}}'); writeFileSync(join(sdk, "dist/index.js"), "");
  writeFileSync(entry, `import { AsyncLocalStorage } from 'node:async_hooks'; export const runnerFactoryProtocol='native-future-factory-v1'; export const runnerSdkDirectory=${JSON.stringify(sdk)}; export const piEnvironmentScope=new AsyncLocalStorage(); export const openPiSession=async()=>({command:async()=>{},close:async()=>{}}); export const runnerProjectionContinuity=()=>true;`);
  return { root, release, entry, sdk };
}

test("exact commit-addressed factory loads once and rejects changed entry bytes or mutable SDK", async () => {
  const f = fixture();
  const identified = identifyRunnerFactory(f.entry);
  expect(identified.ok).toBe(true); if (!identified.ok) throw new Error(identified.error.message);
  expect(await loadRunnerFactory(identified.value)).toMatchObject({ ok: false, error: { code: "factory-unsealed" } });
  chmodSync(f.sdk, 0o555);
  const loaded = await loadRunnerFactory(identified.value);
  expect(loaded).toMatchObject({ ok: true, value: { identity: identified.value } });
  writeFileSync(f.entry, "export const changed=true;");
  expect(await loadRunnerFactory(identified.value)).toMatchObject({ ok: false, error: { code: "factory-conflict" } });
  chmodSync(f.sdk, 0o755);
});

test("native Node resolves an import-only SDK from the candidate graph, not the caller graph", () => {
  const f = fixture(); chmodSync(f.sdk, 0o555);
  const source = fileURLToPath(new URL("../src/threads/runner-factory.ts", import.meta.url));
  const script = `import {readFileSync} from 'node:fs'; import {stripTypeScriptTypes,createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
    const entry=process.argv[1];
    try {createRequire(pathToFileURL(entry)).resolve('@earendil-works/pi-coding-agent');throw Error('require unexpectedly resolved import-only fixture')} catch(error) {if(error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error}
    const factory=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(readFileSync(process.argv[2],'utf8'),{mode:'transform'})).toString('base64'));
    const identity=factory.identifyRunnerFactory(entry); if(!identity.ok)throw Error(JSON.stringify(identity));
    const loaded=await factory.loadRunnerFactory(identity.value);if(!loaded.ok)throw Error(JSON.stringify(loaded));console.log(JSON.stringify(identity.value));`;
  const identity = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script, f.entry, source], { encoding: "utf8", timeout: 5000 }));
  expect(identity.sdkDirectory).toBe(f.sdk);
  expect(identity.entryPath).toBe(f.entry);
  chmodSync(f.sdk, 0o755);
});

test("selectors and absent source seals cannot manufacture immutable factory identities", async () => {
  const f = fixture(), selector = join(f.root, "selected.js");
  symlinkSync(f.entry, selector);
  expect(identifyRunnerFactory(selector)).toMatchObject({ ok: false, error: { code: "factory-unsealed" } });
  rmSync(join(f.release, ".pi-stack-commit"));
  const identified = identifyRunnerFactory(f.entry);
  expect(identified).toMatchObject({ ok: true, value: { sourceCommit: null } });
  if (identified.ok) expect(await loadRunnerFactory(identified.value)).toMatchObject({ ok: false, error: { code: "factory-unsealed" } });
});
