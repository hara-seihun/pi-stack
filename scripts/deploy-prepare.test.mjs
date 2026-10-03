import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeout = spawnSync("bash", ["-c", "command -v timeout"], { encoding: "utf8" }).stdout.trim();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-prepare-"));
  const repo = join(directory, "repo"), bin = join(directory, "bin");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(bin);
  for (const name of ["lib", "release-checkout", "prepare", "runtime", "retain", "write-retain"]) copyFileSync(join(root, "deploy", name), join(repo, "deploy", name));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_STACK_HOST_LOCK_HELD: "0", PI_STACK_HOST_LOCK_PATH: join(directory, "host.lock"), PI_STACK_DEPLOY_LOCK_HELD: "0", PI_STACK_DEPLOY_DEADLINE_ACTIVE: "0", PI_STACK_ALLOW_DIRTY: "0", PI_STACK_DEPLOY_NO_SUDO: "1", PI_STACK_WRITE_GPU_ENABLED: "0", TRACE: join(directory, "trace"), TMPDIR: join(directory, "tmp"), PI_STACK_RUNTIME_DEST: join(directory, "srv/runtime"), PI_STACK_DEPENDENCIES_ROOT: join(directory, "srv/dependencies") };
  mkdirSync(env.TMPDIR);
  function executable(path, source) { writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`, { mode: 0o755 }); }
  function commit() {
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]]) {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  function run(name, extra = {}, args = []) {
    return spawnSync(join(repo, "deploy", name), args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 3000 });
  }
  return { directory, repo, bin, env, executable, commit, run, close: () => rmSync(directory, { recursive: true, force: true }) };
}

function rewriteFixture(f) {
  const manifests = join(f.repo, "apps/write/rewrite-runtime");
  const cache = join(f.directory, "rewrite-cache");
  mkdirSync(manifests, { recursive: true });
  mkdirSync(cache);
  copyFileSync(join(root, "deploy/write-rewrite-runtime"), join(f.repo, "deploy/write-rewrite-runtime"));
  copyFileSync(join(root, "apps/write/rewrite-runtime/install.py"), join(manifests, "install.py"));
  const archive = join(cache, "runtime.zip");
  const packed = spawnSync("python3", ["-c", `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as bundle:
    bundle.writestr('build/bin/llama-server', '#!/bin/sh\\necho fixture-version\\n')
    bundle.writestr('build/bin/LICENSE', 'MIT fixture')
`, archive], { encoding: "utf8", timeout: 3000 });
  assert.equal(packed.status, 0, packed.stderr);
  const model = join(cache, "model.gguf");
  writeFileSync(model, "GGUFfixture");
  for (const [name, file, fields] of [
    ["runtime", archive, { archive_prefix: "build/bin/", files: ["llama-server", "LICENSE"], minimum_glibc: "2.34", cpu_flags: [] }],
    ["model", model, {}],
  ]) {
    const bytes = readFileSync(file);
    writeFileSync(join(manifests, `${name}.json`), JSON.stringify({
      ...fields, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
      url: "https://fixture.invalid/never-download-rewrite",
    }));
  }
  f.env.PI_STACK_WRITE_REWRITE_CACHE = cache;
}

function preparationFixture() {
  const f = fixture();
  f.executable(join(f.bin, "systemctl"), 'echo "preparation must delegate host discovery to its components" >&2; exit 64');
  writeFileSync(join(f.repo, "deploy/lib"), `${readFileSync(join(root, "deploy/lib"), "utf8")}\npi_stack_prepare_builds() { test "\${PI_STACK_DEPLOY_DEADLINE_ACTIVE:-}" = 1 || return 64; printf 'builds\\n' >> "$TRACE"; return "\${BUILD_EXIT:-0}"; }\n`);
  for (const name of ["runtime", "write-engine", "host"]) {
    f.executable(join(f.repo, "deploy", name), `root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/deploy/lib"
pi_stack_enter_deployment "$0" "$root" "$@"
printf '%s\\n' "${name}" >> "$TRACE"
sleep "\${WORK_SECONDS:-0}"
exit "\${${name.toUpperCase().replaceAll("-", "_")}_EXIT:-0}"`);
  }
  // Any nested activation deadline fails immediately, without a 50-second test.
  f.executable(join(f.bin, "timeout"), 'printf "deadline %s\\n" "$*" >> "$TRACE"; exit 124');
  f.commit();
  return f;
}

test("preparation uses the caller deadline for every child; standalone components keep theirs", () => {
  const f = preparationFixture();
  try {
    const prepared = f.run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.stderr, "");
    assert.deepEqual(readFileSync(f.env.TRACE, "utf8").trim().split("\n").sort(), ["builds", "runtime", "write-engine"]);
    for (const name of ["host", "runtime", "write-engine"]) {
      const deployed = f.run(name);
      assert.equal(deployed.status, 124, deployed.stderr);
    }
    assert.equal(readFileSync(f.env.TRACE, "utf8").match(/deadline --signal=TERM --kill-after=2s 50s /g).length, 3);
  } finally { f.close(); }
});

for (const writeLoadState of ["loaded", "not-found"]) test(`Write owns host discovery during preparation with its unit ${writeLoadState}`, () => {
  const f = preparationFixture();
  try {
    copyFileSync(join(root, "deploy/write-engine"), join(f.repo, "deploy/write-engine"));
    rewriteFixture(f);
    f.executable(join(f.bin, "systemctl"), `[[ "$*" == "show pi-stack-write.service -p LoadState --value" ]] || exit 64
printf 'discovery\\n' >> "$TRACE"
printf '%s\\n' '${writeLoadState}'`);
    f.executable(join(f.bin, "uv"), 'printf "uv\\n" >> "$TRACE"; exit 23');
    f.executable(join(f.bin, "curl"), 'echo "fixture must not download weights" >&2; exit 64');
    const sources = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "apps/write/engine"], { encoding: "utf8" });
    assert.equal(sources.status, 0, sources.stderr);
    assert.notEqual(sources.stdout, "", "the fixture needs the tracked Write engine inputs");
    for (const file of sources.stdout.split("\0").filter(Boolean)) {
      mkdirSync(dirname(join(f.repo, file)), { recursive: true });
      copyFileSync(join(root, file), join(f.repo, file));
    }
    f.commit();
    const destination = join(f.directory, "write-engine");
    const result = f.run("prepare", { PI_STACK_WRITE_ENGINE_DEST: destination, PI_STACK_WRITE_ENGINE_FORCE: "0" });
    const calls = readFileSync(f.env.TRACE, "utf8").trim().split("\n").sort();
    if (writeLoadState === "loaded") {
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(calls, ["builds", "discovery", "runtime", "uv"]);
      assert.match(result.stderr, /write-engine exited 23/);
      assert.doesNotMatch(result.stdout, /prepared Pi stack/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(calls, ["builds", "discovery", "runtime"]);
      assert.match(result.stdout, /nothing to prepare/);
      assert.equal(existsSync(join(f.directory, ".pi-write")), false);
    }
    assert.equal(existsSync(destination), false);
  } finally { f.close(); }
});

test("Write resumes model downloads, reuses pinned copies, and keeps verified weights across dependency changes", () => {
  const f = fixture();
  try {
    copyFileSync(join(root, "deploy/write-engine"), join(f.repo, "deploy/write-engine"));
    rewriteFixture(f);
    const source = join(f.repo, "apps/write/engine");
    mkdirSync(join(source, "cleanup"), { recursive: true });
    const bytes = Buffer.from("fixture pinned model bytes\n".repeat(8));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const payload = join(f.directory, "payload");
    writeFileSync(payload, bytes);
    writeFileSync(join(source, "requirements.lock"), "first dependencies\n");
    writeFileSync(join(source, "requirements-gpu.lock"), "GPU dependencies\n");
    writeFileSync(join(source, "gpu-model.json"), '{}\n');
    writeFileSync(join(source, "server.py"), "# fixture\n");
    writeFileSync(join(source, "convert_fp32.py"), 'import os\nwith open(os.environ["TRACE"], "a") as f: f.write("convert\\n")\n');
    writeFileSync(join(source, "model.json"), JSON.stringify({
      files: { "encoder.onnx": digest }, repository: "fixture", revision: "pin",
      tokenizer_file: "tokenizer.json", tokenizer_repository: "fixture", tokenizer_revision: "pin", tokenizer_sha256: digest,
    }));
    writeFileSync(join(source, "cleanup/model.json"), JSON.stringify({ release: "https://fixture.invalid", files: { "joint-f32.onnx": digest } }));
    const punctuationFiles = ["punct_cap_seg_en.onnx", "spe_32k_lc_en.model"];
    writeFileSync(join(source, "punctuation-model.json"), JSON.stringify({
      repository: "fixture", revision: "pin", files: Object.fromEntries(punctuationFiles.map(file => [file, digest])),
    }));
    const store = join(f.directory, ".pi-write");
    const cached = join(store, "weights-cached/shared");
    mkdirSync(cached, { recursive: true });
    writeFileSync(join(cached, "tokenizer.json"), bytes);
    f.executable(join(f.bin, "uv"), `if [[ $1 == venv ]]; then
  mkdir -p "\${@: -1}/bin"
  ln -s "$(command -v python3)" "\${@: -1}/bin/python"
fi`);
    f.executable(join(f.bin, "sleep"), ":");
    f.executable(join(f.bin, "curl"), `while (( $# )); do
  if [[ $1 == -o ]]; then destination=$2; shift; fi
  shift
done
size=0
[[ ! -f $destination ]] || size=$(stat -c %s "$destination")
printf '%s %s\\n' "$(basename "$destination")" "$size" >> "$TRACE"
if (( size == 0 )); then
  head -c 32 "$PAYLOAD" > "$destination"
  printf '200'
  exit 92
fi
tail -c +$((size + 1)) "$PAYLOAD" >> "$destination"
printf '206'`);
    f.commit();
    const destination = join(f.directory, "write-engine");
    const env = { PI_STACK_WRITE_ENGINE_DEST: destination, PI_STACK_WRITE_ENGINE_FORCE: "1", PAYLOAD: payload };
    const first = f.run("write-engine", env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(destination), false, "preparation never selects the engine");
    assert.equal(f.run("write-engine", env, ["--select"]).status, 0);
    const firstTree = realpathSync(destination);
    const weights = realpathSync(join(destination, "model"));
    const venv = realpathSync(join(destination, "venv"));
    const rewriteRuntime = realpathSync(join(destination, "rewrite-runtime"));
    const rewriteModel = realpathSync(join(destination, "rewrite-model"));
    assert.match(readFileSync(join(rewriteRuntime, "bin/llama-server"), "utf8"), /fixture-version/);
    assert.equal(readFileSync(join(rewriteModel, "model.gguf"), "utf8"), "GGUFfixture");
    assert.deepEqual(readFileSync(join(weights, "encoder.onnx")), bytes);
    assert.deepEqual(readFileSync(join(weights, "shared/tokenizer.json")), bytes);
    assert.deepEqual(readFileSync(join(destination, "cleanup-model/joint-f32.onnx")), bytes);
    const trace = readFileSync(f.env.TRACE, "utf8");
    assert.equal(trace, "encoder.onnx.part 0\nencoder.onnx.part 32\nconvert\njoint-f32.onnx.part 0\njoint-f32.onnx.part 32\npunct_cap_seg_en.onnx.part 0\npunct_cap_seg_en.onnx.part 32\nspe_32k_lc_en.model.part 0\nspe_32k_lc_en.model.part 32\n");
    const punctuation = realpathSync(join(destination, "punctuation-model"));
    for (const file of punctuationFiles) assert.deepEqual(readFileSync(join(punctuation, file)), bytes);
    writeFileSync(join(source, "requirements.lock"), "second dependencies\n");
    f.commit();
    const second = f.run("write-engine", env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(realpathSync(destination), firstTree, "preparation leaves the live selection unchanged");
    assert.equal(f.run("write-engine", env, ["--select"]).status, 0);
    assert.notEqual(realpathSync(destination), firstTree);
    assert.notEqual(realpathSync(join(destination, "venv")), venv);
    assert.equal(realpathSync(join(destination, "model")), weights);
    assert.equal(readFileSync(f.env.TRACE, "utf8"), trace, "dependency changes neither download nor convert weights again");
    assert.equal(existsSync(join(firstTree, "ready")), true, "previous release remains selectable");
    assert.equal(existsSync(join(firstTree, "venv/bin/python")), true, "previous dependencies remain available");
    assert.equal(realpathSync(join(destination, "punctuation-model")), punctuation);
    const secondTree = realpathSync(destination);
    assert.equal(realpathSync(join(destination, "rewrite-runtime")), rewriteRuntime);
    assert.equal(realpathSync(join(destination, "rewrite-model")), rewriteModel);
    const selected = f.run("write-engine", env, ["--select"]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(realpathSync(`${destination}.previous`), firstTree, "repeat selection preserves the distinct rollback tree");
    const proc = join(f.directory, "empty-proc");
    mkdirSync(proc);
    const retained = f.run("write-engine", { ...env, PI_STACK_WRITE_PROC_ROOT: proc }, ["--retain"]);
    assert.equal(retained.status, 0, retained.stderr);
    assert.equal(existsSync(join(firstTree, "venv/bin/python")), true, "acceptance retention keeps previous dependencies");
    writeFileSync(join(rewriteModel, "model.gguf"), "BADUfixture");
    const corruptRewrite = f.run("write-engine", env, ["--select"]);
    assert.equal(corruptRewrite.status, 65, corruptRewrite.stderr);
    assert.match(corruptRewrite.stderr, /rewrite runtime\/model is missing or corrupt/);
    assert.equal(realpathSync(destination), secondTree, "selection cannot accept corrupt rewrite assets");
    const repairedRewrite = f.run("write-engine", env);
    assert.equal(repairedRewrite.status, 0, repairedRewrite.stderr);
    assert.equal(readFileSync(join(rewriteModel, "model.gguf"), "utf8"), "GGUFfixture");
    assert.equal(readFileSync(f.env.TRACE, "utf8"), trace, "rewrite preparation reuses the seed without downloading");
    writeFileSync(join(punctuation, punctuationFiles[0]), "corrupt model");
    const corrupt = f.run("write-engine", env);
    assert.equal(corrupt.status, 1, corrupt.stderr);
    assert.match(corrupt.stderr, /punctuation checksum mismatch/);
    assert.equal(realpathSync(destination), secondTree, "a ready stamp cannot select corrupt assets");
  } finally { f.close(); }
});

test("preparation reports each failed child and never reports success", () => {
  const f = preparationFixture();
  try {
    const result = f.run("prepare", { RUNTIME_EXIT: "23", WRITE_ENGINE_EXIT: "11", BUILD_EXIT: "9" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /builds exited 9/);
    assert.match(result.stderr, /runtime exited 23/);
    assert.match(result.stderr, /write-engine exited 11/);
    assert.doesNotMatch(result.stdout, /prepared Pi stack/);
  } finally { f.close(); }
});

test("the caller can still terminate preparation and its children", () => {
  const f = preparationFixture();
  try {
    const result = spawnSync(timeout, ["--kill-after=1s", "0.2s", join(f.repo, "deploy/prepare")], {
      env: { ...f.env, WORK_SECONDS: "2" }, encoding: "utf8", timeout: 2000,
    });
    assert.equal(result.status, 124, result.stderr);
    assert.doesNotMatch(result.stdout, /prepared Pi stack/);
    assert.doesNotMatch(readFileSync(f.env.TRACE, "utf8"), /deadline/);
  } finally { f.close(); }
});

test("preparation still refuses dirty source", () => {
  const f = preparationFixture();
  try {
    writeFileSync(join(f.repo, "uncommitted"), "change");
    const result = f.run("prepare");
    assert.equal(result.status, 65, result.stderr);
    assert.equal(existsSync(f.env.TRACE), false);
  } finally { f.close(); }
});

for (const signal of ["TERM", "INT", "HUP", "failure"]) {
  test(`runtime removes unpublished dependency stages after ${signal}`, () => {
    const f = fixture();
    try {
      for (const dir of ["packages/runtime", "vendor/pi", "apps", "tools"]) mkdirSync(join(f.repo, dir), { recursive: true });
      for (const name of ["package.json", "package-lock.json", "vendor/pi/package.tgz"]) writeFileSync(join(f.repo, name), "{}\n");
      const runtimeSource = readFileSync(join(root, "deploy/runtime"), "utf8");
      const hashInputs = runtimeSource.match(/sha256sum (.+)\n/)[1].split(" ");
      for (const name of hashInputs.filter((name) => name !== "package.json" && name !== "package-lock.json")) {
        mkdirSync(dirname(join(f.repo, name)), { recursive: true });
        writeFileSync(join(f.repo, name), "\n");
      }
      f.executable(join(f.bin, "npm"), 'mkdir -p node_modules/.bin');
      f.executable(join(f.bin, "node"), 'exit 0');
      f.executable(join(f.bin, "rsync"), `touch "\${@: -1}/partial"
${signal === "failure" ? "exit 23" : `kill -${signal} "$PPID"; exit 20`}`);
      f.commit();
      const dependencies = join(f.directory, "dependencies"), destination = join(f.directory, "runtime");
      mkdirSync(destination);
      writeFileSync(join(destination, ".pi-stack-commit"), "selected-release\n");
      const result = f.run("runtime", { PI_STACK_DEPLOY_DEADLINE_ACTIVE: "1", PI_STACK_DEPENDENCIES_ROOT: dependencies, PI_STACK_RUNTIME_DEST: destination });
      assert.equal(result.status, { TERM: 143, INT: 130, HUP: 129, failure: 23 }[signal], result.stderr);
      assert.deepEqual(readdirSync(dependencies), [], "partial dependencies cannot survive interruption");
      assert.deepEqual(readdirSync(f.env.TMPDIR), [], "temporary npm staging is removed too");
      assert.equal(readFileSync(join(destination, ".pi-stack-commit"), "utf8"), "selected-release\n");
    } finally { f.close(); }
  });
}
