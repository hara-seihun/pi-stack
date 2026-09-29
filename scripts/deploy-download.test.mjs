import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const curl = spawnSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
const content = Buffer.from("pinned model bytes\n".repeat(4096));
const digest = createHash("sha256").update(content).digest("hex");

async function fixture(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-download-"));
  const bin = join(directory, "bin"), destination = join(directory, "model");
  mkdirSync(bin);
  // Keep retry timing deterministic and sub-second, while checking the budget.
  writeFileSync(join(bin, "sleep"), '#!/usr/bin/env bash\necho "$1" >> "$WAITS"\n', { mode: 0o755 });
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.range ?? null);
    handler(request, response, requests.length);
  });
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/model`;
  async function run(extra = {}) {
    const child = spawn("bash", ["-c", 'set -euo pipefail; source "$1/deploy/lib"; pi_stack_download_artifact "$2" "$3" "$4"', "fixture", root, url, destination, digest], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WAITS: join(directory, "waits"), NO_PROXY: "127.0.0.1", ...extra },
      stdio: ["ignore", "pipe", "pipe"], timeout: 3000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [status, signal] = await once(child, "close");
    assert.equal(signal, null, stderr);
    return { status, stdout, stderr };
  }
  function complete(request, response) {
    const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
    response.writeHead(offset ? 206 : 200, {
      "Content-Length": content.length - offset,
      ...(offset ? { "Content-Range": `bytes ${offset}-${content.length - 1}/${content.length}` } : {}),
    });
    response.end(content.subarray(offset));
  }
  return { directory, bin, destination, requests, run, complete, part: `${destination}.part` };
}

for (const reset of [18, 92]) test(`resumes retained bytes after curl ${reset} and reuses verified artifacts`, async (t) => {
  const f = await fixture(t, (request, response, count) => {
    if (count === 1) {
      response.writeHead(200, { "Content-Length": content.length, Connection: "close" });
      response.end(content.subarray(0, 8192));
    } else f.complete(request, response);
  });
  if (reset === 92) {
    // The real HTTP fixture interrupts a body (18); map that transport result to
    // the production HTTP/2 reset (92), retaining curl's actual partial output.
    writeFileSync(join(f.bin, "curl"), `#!/usr/bin/env bash\n${JSON.stringify(curl)} "$@"\nstatus=$?\nif (( status == 18 )); then exit 92; fi\nexit "$status"\n`, { mode: 0o755 });
  }
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`Retrying .* after curl ${reset}`));
  assert.deepEqual(f.requests, [null, "bytes=8192-"]);
  assert.deepEqual(readFileSync(f.destination), content);
  assert.equal(existsSync(f.part), false);
  assert.equal((await f.run()).status, 0);
  assert.equal(f.requests.length, 2, "verified destination does not fetch again");
});

test("resumes partial state retained by an earlier preparation", async (t) => {
  const f = await fixture(t, (request, response) => f.complete(request, response));
  writeFileSync(f.part, content.subarray(0, 16384));
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.requests, ["bytes=16384-"]);
  assert.deepEqual(readFileSync(f.destination), content);
});

test("promotes an already verified partial without a network request", async (t) => {
  const f = await fixture(t, (_request, response) => response.writeHead(500).end());
  writeFileSync(f.part, content);
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(readFileSync(f.destination), content);
});

for (const http of [200, 416]) test(`restarts when a server rejects resumption with HTTP ${http}`, async (t) => {
  const f = await fixture(t, (request, response, count) => {
    if (count === 1) response.writeHead(http, { "Content-Length": content.length }).end(content);
    else f.complete(request, response);
  });
  writeFileSync(f.part, content.subarray(0, 16384));
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.requests, ["bytes=16384-", null]);
  assert.deepEqual(readFileSync(f.destination), content);
});

test("checksum mismatch never replaces a destination or leaves poison partial state", async (t) => {
  const f = await fixture(t, (_request, response) => response.end("wrong bytes"));
  writeFileSync(f.destination, "previous destination");
  const result = await f.run();
  assert.equal(result.status, 65, result.stderr);
  assert.match(result.stderr, /Checksum mismatch/);
  assert.equal(readFileSync(f.destination, "utf8"), "previous destination");
  assert.equal(existsSync(f.part), false);
  assert.equal(f.requests.length, 1);
});

test("permanent HTTP failure stops immediately and keeps the resumable prefix", async (t) => {
  const f = await fixture(t, (_request, response) => response.writeHead(404).end());
  const prefix = content.subarray(0, 8192);
  writeFileSync(f.part, prefix);
  const result = await f.run();
  assert.equal(result.status, 22, result.stderr);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(readFileSync(f.part), prefix);
  assert.equal(existsSync(f.destination), false);
});

test("transient HTTP failures have four attempts with backoff and retain partial state", async (t) => {
  const f = await fixture(t, (_request, response) => response.writeHead(503).end());
  const prefix = content.subarray(0, 8192);
  writeFileSync(f.part, prefix);
  const result = await f.run();
  assert.equal(result.status, 22, result.stderr);
  assert.match(result.stderr, /exhausted 4 attempts/);
  assert.deepEqual(f.requests, Array(4).fill("bytes=8192-"));
  assert.equal(readFileSync(join(f.directory, "waits"), "utf8"), "1\n2\n4\n");
  assert.deepEqual(readFileSync(f.part), prefix);
  assert.equal(existsSync(f.destination), false);
});

test("repeated HTTP/2 resets exhaust the budget without discarding progress", async (t) => {
  const f = await fixture(t, (_request, response) => response.end());
  writeFileSync(join(f.bin, "curl"), `#!/usr/bin/env bash
while (( $# )); do
  if [[ $1 == -o ]]; then destination=$2; shift; fi
  shift
done
printf 'prefix' >> "$destination"
printf '200'
exit 92
`, { mode: 0o755 });
  const result = await f.run();
  assert.equal(result.status, 92, result.stderr);
  assert.match(result.stderr, /exhausted 4 attempts/);
  assert.equal(readFileSync(f.part, "utf8"), "prefix".repeat(4));
  assert.equal(existsSync(f.destination), false);
});
