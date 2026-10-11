import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  writeFileSync(join(sdk, "package.json"), '{"main":"dist/index.js"}'); writeFileSync(join(sdk, "dist/index.js"), "");
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

test("selectors and absent source seals cannot manufacture immutable factory identities", async () => {
  const f = fixture(), selector = join(f.root, "selected.js");
  symlinkSync(f.entry, selector);
  expect(identifyRunnerFactory(selector)).toMatchObject({ ok: false, error: { code: "factory-unsealed" } });
  rmSync(join(f.release, ".pi-stack-commit"));
  const identified = identifyRunnerFactory(f.entry);
  expect(identified).toMatchObject({ ok: true, value: { sourceCommit: null } });
  if (identified.ok) expect(await loadRunnerFactory(identified.value)).toMatchObject({ ok: false, error: { code: "factory-unsealed" } });
});
