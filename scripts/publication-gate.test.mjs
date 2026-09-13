import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("a failed integration retains its SHA, command and diagnostics without publishing main", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["requests", "bin", "repository/.git", "repository/deploy", "canonical/apps/kenan/android"]) mkdirSync(join(root, path), { recursive: true });
  const source = "a".repeat(40), base = "b".repeat(40), integration = "c".repeat(40);
  const requestId = "PUB-0123456789abcdef01234567";
  const receipt = join(root, "requests", `${requestId}.json`);
  writeFileSync(receipt, JSON.stringify({ requestId, sourceSha: source, sourceRef: `refs/heads/pi-stack-publications/${requestId}`, status: "queued", step: "queued", attempt: 0, queuedAt: "2026-09-13", failures: [] }));
  writeFileSync(join(root, "repository/deploy/lib"), 'pi_stack_prepare_dependencies() { :; }\n');
  writeFileSync(join(root, "canonical/apps/kenan/android/local.properties"), "fixture=true\n");
  writeFileSync(join(root, "bin/git"), `#!/bin/sh
case "$*" in
  *push*) echo 'unexpected push' >&2; exit 99;;
  *'remote get-url origin'*) echo https://github.com/hara-seihun/pi-stack.git;;
  *'rev-parse refs/pi-stack-publication/'*) echo ${source};;
  *'rev-parse refs/remotes/origin/main'*) echo ${base};;
  *'rev-parse HEAD'*) echo ${integration};;
  *'merge-base --is-ancestor'*) exit 1;;
esac
`, { mode: 0o700 });
  writeFileSync(join(root, "bin/npm"), '#!/bin/sh\necho "(fail) integration fixture rejects wrong core" >&2\necho "Expected: 201" >&2\necho "Received: 409" >&2\nexit 1\n', { mode: 0o700 });
  writeFileSync(join(root, "bin/alert"), '#!/bin/sh\necho /fixture/alert.md\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../deploy/publication", import.meta.url)), "drain"], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_REPOSITORY: join(root, "canonical"), PI_STACK_PUBLICATION_ALERT_COMMAND: join(root, "bin/alert") },
  });
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.integrationSha, integration);
  assert.equal(failed.baseSha, base);
  assert.equal(failed.checks.status, "failed");
  assert.equal(failed.failure.step, "checks");
  assert.equal(failed.failure.command, "npm run check && npm run android:test --workspace=kenan");
  assert.match(failed.failure.excerpt, /integration fixture rejects wrong core/);
  assert.match(failed.failure.excerpt, /Received: 409/);
  assert.equal(failed.alert.status, "filed");
  assert.equal(failed.hosts, undefined);
  assert.equal(failed.integratedAt, undefined);
  assert.match(readFileSync(failed.failure.log, "utf8"), /checks/);
});
