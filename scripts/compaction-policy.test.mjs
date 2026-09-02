import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("pins VCC with a 250,000-token inter-turn guard", async () => {
  const [manifestText, settingsDeploy] = await Promise.all([
    read("config/packages.json"),
    read("deploy/settings"),
  ]);
  const manifest = JSON.parse(manifestText);
  const vcc = manifest.packages.find((entry) => entry.id === "vcc");

  assert.match(vcc.source, /^git:github\.com\/hara-seihun\/pi-vcc@[0-9a-f]{40}$/);
  assert.match(settingsDeploy, /"interTurnCompactionTokens": 250000/);
  assert.match(settingsDeploy, /select\(startswith\("npm:"\) or startswith\("git:"\) or contains\(":\/\/"\)\)/);
});
