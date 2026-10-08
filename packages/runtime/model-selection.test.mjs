import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

test("installed doctor checks SDK and bundled CLI through account and runtime symlinks", { timeout: 30000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-installed-model-doctor-"));
  try {
    const modules = join(directory, "node_modules");
    mkdirSync(join(modules, "@earendil-works"), { recursive: true });
    mkdirSync(join(modules, ".bin"));
    mkdirSync(join(directory, "bin"));
    const runtime = process.env.PI_TEST_RUNTIME_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent");
    symlinkSync(dirname(dirname(fileURLToPath(runtime))), join(modules, "@earendil-works/pi-coding-agent"));
    copyFileSync(new URL("./model-selection-doctor.mjs", import.meta.url), join(directory, "model-selection-doctor.mjs"));
    symlinkSync("../../model-selection-doctor.mjs", join(modules, ".bin/pi-model-selection-doctor"));
    const command = join(directory, "bin/pi-model-selection-doctor");
    symlinkSync("../node_modules/.bin/pi-model-selection-doctor", command);
    const env = { ...process.env };
    delete env.PI_TEST_RUNTIME_ENTRY;
    const run = extra => spawnSync(process.execPath, [command], { env: { ...env, ...extra }, encoding: "utf8", timeout: 25000 });
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.notEqual(success.stdout.trim(), "", "the installed entrypoint must run the doctor, not silently exit");
    const result = JSON.parse(success.stdout);
    assert.equal(result.explicitProviderRequests, 1);
    assert.equal(result.admissionFailuresVetoInference, true);
    assert.equal(result.extensionProvidersBeforeSelection, true);
    const failure = run({ PI_TEST_RUNTIME_ENTRY: pathToFileURL(join(directory, "missing-runtime.mjs")).href });
    assert.equal(failure.status, 1, failure.stderr);
    assert.match(failure.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
