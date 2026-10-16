import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [moduleFile, output, expected] = process.argv.slice(2);
assert.ok(path.isAbsolute(moduleFile) && path.isAbsolute(output));
assert.ok(["ready", "baseline-failure"].includes(expected));
mkdirSync(path.dirname(output), { recursive: true });
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const env = { HOME: homedir(), PATH: "/opt/bun-v1.3.11:/usr/local/bin:/usr/bin:/bin" };
const report = { host: hostname(), at: new Date().toISOString(), uid: process.geteuid(), moduleFile,
  moduleSHA256: digest(moduleFile), missingConnectionVariables: true, cases: [] };
for (const mode of expected === "ready" ? ["absent", "explicit", "invalid"] : ["absent"]) {
  const directory = path.join(path.dirname(output), `${path.basename(output, ".json")}-${mode}`);
  const worker = `import { finishSourceJob } from ${JSON.stringify(pathToFileURL(moduleFile).href)};
    const uid = process.geteuid();
    const valid = process.env.XDG_RUNTIME_DIR === '/run/user/' + uid &&
      process.env.DBUS_SESSION_BUS_ADDRESS === 'unix:path=/run/user/' + uid + '/bus';
    finishSourceJob(process.env.PI_WORKSPACE_SOURCE_JOB_DIR, valid ?
      {state:'ready',value:{uid,workerEnvironmentResolved:true}} :
      {state:'failed',error:{code:'proof-worker-environment',message:'worker lacks resolved user environment'}});`;
  const script = `import { runSourceJob, sourceJobId } from ${JSON.stringify(pathToFileURL(moduleFile).href)};
    const request = {purpose:'user-manager-installed-proof',mode:${JSON.stringify(mode)}};
    const options = {directory:${JSON.stringify(directory)},key:'user-manager-proof',request,
      command:[process.execPath,'--input-type=module','-e',${JSON.stringify(worker)}],waitMs:5000};
    const first = runSourceJob(options); const second = runSourceJob(options);
    console.log(JSON.stringify({first,second,jobId:sourceJobId(options.key,request)}));`;
  const connection = mode === "explicit" ? { XDG_RUNTIME_DIR: `/run/user/${process.geteuid()}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.geteuid()}/bus` } :
    mode === "invalid" ? { XDG_RUNTIME_DIR: "" } : {};
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script],
    { env: { ...env, ...connection }, encoding: "utf8", timeout: 15000 });
  const item = { mode, exitCode: child.status, signal: child.signal, stderr: child.stderr, output: child.stdout };
  report.cases.push(item);
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  assert.equal(child.status, 0, JSON.stringify(item));
  const result = JSON.parse(child.stdout);
  item.result = result;
  const jobDirectory = path.join(directory, result.jobId);
  const attemptPath = path.join(jobDirectory, "attempt.json");
  item.attempt = existsSync(attemptPath) ? JSON.parse(readFileSync(attemptPath)) : null;
  const requestPath = path.join(jobDirectory, "request.json");
  item.requestSHA256 = digest(requestPath);
  if (expected === "baseline-failure") {
    assert.equal(result.first.state, "failed");
    assert.ok(["source-job-unsupported", "source-job-submit-failed"].includes(result.first.error.code));
  } else if (mode === "invalid") {
    assert.equal(result.first.state, "failed");
    assert.equal(result.first.error.code, "source-job-user-environment");
    assert.equal(item.attempt, null);
  } else {
    assert.equal(result.first.state, "ready", JSON.stringify(result));
    assert.deepEqual(result.first, result.second);
    assert.equal(result.first.value.workerEnvironmentResolved, true);
    assert.equal(item.attempt.number, 1);
    item.terminalSHA256 = digest(path.join(jobDirectory, "result.json"));
    const environment = JSON.parse(readFileSync(path.join(jobDirectory, "environment.json")));
    item.savedConnection = { XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS };
  }
  if (item.attempt) {
    const unit = spawnSync("systemctl", ["--user", "show", item.attempt.unit,
      "--property=LoadState,ActiveState,SubState,MainPID,ControlGroup,Result,ExecMainStatus"],
      { env: { ...env, XDG_RUNTIME_DIR: `/run/user/${process.geteuid()}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.geteuid()}/bus` }, encoding: "utf8", timeout: 2500 });
    item.unit = { exitCode: unit.status, properties: unit.stdout, stderr: unit.stderr };
  }
}
report.passed = true;
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, host: report.host, expected, moduleSHA256: report.moduleSHA256, output }));
