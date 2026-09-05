import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("pins VCC with an OpenAI Astra override on the default compaction guard", async () => {
  const [manifestText, settingsDeploy] = await Promise.all([
    read("config/packages.json"),
    read("deploy/settings"),
  ]);
  const manifest = JSON.parse(manifestText);
  const vcc = manifest.packages.find((entry) => entry.id === "vcc");

  assert.match(vcc.source, /^git:github\.com\/hara-seihun\/pi-vcc@[0-9a-f]{40}$/);
  const config = JSON.parse(settingsDeploy.match(/cat > "\$vcc_config" <<'JSON'\n([\s\S]*?)\nJSON/)[1]);
  assert.equal(config.interTurnCompactionTokens, 250000);
  assert.deepEqual(config.interTurnCompactionTokensByModel, {
    "openai/gpt-6-astra": 500000,
    "openai-codex/gpt-6-astra": 500000,
  });
  assert.match(settingsDeploy, /select\(startswith\("npm:"\) or startswith\("git:"\) or contains\(":\/\/"\)\)/);
});
