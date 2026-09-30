import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPublicationConfig } from "../deploy/publication-config.mjs";

const command = new URL("../deploy/publication", import.meta.url);

test("installation renders host-owned paths and target IDs stay explicit", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = join(root, "publication.json");
  const commandPath = join(root, "owner", "publish");
  const stateRoot = join(root, "state");
  const unitRoot = join(root, "units");
  const config = {
    repositoryUrl: "https://github.com/example/stack.git",
    mergeAuthor: { name: "Release bot", email: "release@example.org" },
    targets: [{ id: "alpha", environmentId: "local", sshHost: null, releaseCommand: join(root, "release"), checkServicesCommand: join(root, "check-services"), releaseRepository: join(root, "checkout"),
      requiredUnits: ["pi-remote-router.service"], voiceStatusUrl: "http://127.0.0.1:8796/status" }],
    paths: { installedCommand: commandPath, stateRoot, userUnitRoot: unitRoot },
  };
  writeFileSync(configPath, JSON.stringify(config));
  const loaded = loadPublicationConfig(configPath);
  assert.equal(loaded.targets[0].id, "alpha");
  assert.equal(loaded.mergeAuthor.email, "release@example.org");
  const installed = spawnSync(process.execPath, [command.pathname, "install"], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, PI_STACK_PUBLICATION_CONFIG: configPath, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(readFileSync(join(unitRoot, "pi-stack-publication.service"), "utf8"), new RegExp(`ExecStart=${commandPath} drain`));
  assert.match(readFileSync(join(unitRoot, "pi-stack-publication.path"), "utf8"), new RegExp(`PathChanged=${stateRoot}/wake`));
  assert.doesNotMatch(readFileSync(join(unitRoot, "pi-stack-publication.service"), "utf8"), /@PUBLICATION_/);
  assert.match(readFileSync(join(root, "owner", "publication-config.mjs"), "utf8"), /loadPublicationConfig/);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\necho 'code-only install must not touch services' >&2\nexit 91\n", { mode: 0o700 });
  const unit = join(unitRoot, "pi-stack-publication.service");
  writeFileSync(unit, "retain host unit\n");
  writeFileSync(commandPath, "retain active owner\n");
  const options = { encoding: "utf8", timeout: 5000,
    env: { ...process.env, PI_STACK_PUBLICATION_CONFIG: configPath, PATH: `${bin}:${process.env.PATH}` } };
  const busy = spawnSync("flock", [join(stateRoot, "worker.lock"), process.execPath, command.pathname, "install", "--code-only"], options);
  assert.notEqual(busy.status, 0);
  assert.equal(readFileSync(commandPath, "utf8"), "retain active owner\n");
  const initialized = spawnSync("git", ["init", "--quiet", join(stateRoot, "repository")], options);
  assert.equal(initialized.status, 0, initialized.stderr);
  const codeOnly = spawnSync(process.execPath, [command.pathname, "install", "--code-only"], options);
  assert.equal(codeOnly.status, 0, codeOnly.stderr);
  assert.equal(readFileSync(unit, "utf8"), "retain host unit\n");
  assert.equal(readFileSync(commandPath, "utf8"), readFileSync(command, "utf8"));
  assert.equal(readFileSync(join(root, "owner", "meeting-census"), "utf8"), readFileSync(new URL("../deploy/meeting-census", import.meta.url), "utf8"));
  config.targets.push({ ...config.targets[0], id: "beta", sshHost: "remote", androidTransferRoot: join(root, "transfer") });
  writeFileSync(configPath, JSON.stringify(config));
  for (const [executable, id] of [["bash", "alpha"], ["ssh", "beta"]]) {
    writeFileSync(join(bin, executable), `#!/bin/sh\necho '{"host":"${id}","runtimes":[]}'\n`, { mode: 0o700 });
  }
  const gate = spawnSync(process.execPath, [command.pathname, "gate-status"], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, PI_STACK_PUBLICATION_CONFIG: configPath, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(gate.status, 0, gate.stderr);
  assert.deepEqual(JSON.parse(gate.stdout).hosts.map(host => host.host), ["alpha", "beta"]);
  config.targets[1].id = "alpha";
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => loadPublicationConfig(configPath), /target IDs must be unique/);
  config.targets[1].id = "beta";
  config.targets[1].releaseCommand = "relative/path";
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => loadPublicationConfig(configPath), /must be absolute/);
});
