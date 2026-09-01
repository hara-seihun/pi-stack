import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("VCC alone owns automatic compaction and continuation", async () => {
  const [manifestText, settingsDeploy, runtimeDeploy, runtimeManifest] = await Promise.all([
    read("config/package-sets.json"),
    read("deploy/settings"),
    read("deploy/runtime"),
    read("packages/runtime/package.json"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.packages["compaction-threshold"], undefined);
  for (const packages of Object.values(manifest.roles)) {
    assert.equal(packages.includes("compaction-threshold"), false);
    assert.equal(packages.includes("vcc"), true);
  }
  assert.doesNotMatch(settingsDeploy, /COMPACTION_THRESHOLD|compaction-threshold/);
  assert.doesNotMatch(runtimeDeploy, /compaction-threshold/);
  assert.doesNotMatch(runtimeManifest, /compaction-threshold/);
  assert.match(settingsDeploy, /compaction: \{ \.\.\.\(current\.compaction \?\? \{\}\), enabled: true \}/);
  assert.match(settingsDeploy, /"continueAfterThresholdCompact": true/);
});
