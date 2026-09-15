import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/publication-request.yml", import.meta.url), "utf8");
const script = workflow.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");
const sha = "a".repeat(40);
const request = `PUB-${sha.slice(0, 24)}`;
function run(environment = {}, denial = false) {
  return spawnSync("bash", ["-c", `
    id() { printf '1000\\n'; }
    sudo() { ${denial ? "return 77" : "printf '%s\\n' \"$@\""}; }
    ${script}
  `], { encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "hara-seihun/pi-stack", SOURCE_SHA: sha,
    REQUEST_REF: `pi-stack-publication-requests/${request}`, ...environment } });
}

test("request transfers the exact source to the installed owner without running deployment", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`/home/kenan/machine/pi-stack-publication\\nenqueue\\n${request}\\n${sha}\\nrefs/heads/pi-stack-publications/${request}\\nnull`));
});

test("invalid repository, request and source never reach the owner", () => {
  for (const env of [{ GITHUB_REPOSITORY: "another/pi-stack" }, { REQUEST_REF: "bad" }, { SOURCE_SHA: "main" }]) {
    const result = run(env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /enqueue/);
  }
});

test("a denied service identity fails the handoff", () => {
  assert.equal(run({}, true).status, 77);
});
