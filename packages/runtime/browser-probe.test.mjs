import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeBrowser, settleBrowserProofs } from "./browser-probe.mjs";

function fixture(t, defect) {
  const directory = mkdtempSync(join(tmpdir(), "browser-probe-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    url: "http://127.0.0.1:1234/", title: "probe", visibleTextCheck: ["wait", "--fn", "true"],
    frameValue: "filled", screenshotPath: join(directory, "image.png"),
    downloadPath: join(directory, "download.txt"), downloadContent: "exact bytes\n",
  };
  const refs = { e1: { name: "Probe" }, e2: { name: "Download probe" }, e3: { name: "Frame input" } };
  const calls = [];
  const sessions = new Map();
  const closed = [];
  const tool = { async execute(_id, input) {
    calls.push(input);
    if (input.script) return { details: { resultCategory: "success", data: { refs: 3 }, scriptSession: { cleanup: defect === "script-cleanup" ? "failed" : "closed" } } };
    const name = input.semanticAction?.session ?? input.args[input.args.indexOf("--session") + 1];
    if (input.semanticAction) {
      const state = sessions.get(name);
      assert.ok(state, "semantic fill reuses the owned live session");
      assert.equal(input.semanticAction.action, "fill");
      if (input.semanticAction.text === undefined) return { details: {
        resultCategory: defect === "semantic-unset-success" ? "success" : "failure",
        failureCategory: "validation-error", validationError: "semanticAction.text is required for fill.",
      } };
      const target = input.semanticAction.selector ?? (input.semanticAction.value === "Controlled date" ? "#controlled-date" : input.semanticAction.value === "Controlled datetime" ? "#controlled-datetime" : "#controlled-timezone");
      if (defect !== "semantic-date-value" && !(defect === "semantic-clear-noop" && input.semanticAction.text === "")) state.values.set(`main:${target}`, input.semanticAction.text);
      if (target === "#controlled-timezone" && !(defect === "semantic-clear-noevent" && input.semanticAction.text === "")) state.timezoneState = input.semanticAction.text;
      state.dateRoute = "semantic";
      return { details: { resultCategory: "success" } };
    }
    const remote = name.startsWith("doctor-attach-");
    if (remote) assert.equal(input.args[input.args.indexOf("--cdp") + 1], "ws://127.0.0.1/probe");
    if (input.args.at(-1) === "close") {
      closed.push(remote ? "attached" : "owner");
      return { details: { resultCategory: remote && defect === "attached-cleanup" ? "failure" : "success" } };
    }
    if (input.outputPath) {
      writeFileSync(input.outputPath, JSON.stringify({ snapshot: defect === "saved-sensitive-value" ? "4242 4242 4242 4242" : "[redacted: cc-number]" }));
      return { details: { resultCategory: "success", data: { snapshot: "[redacted: cc-number]" } } };
    }
    const nativeSteps = JSON.parse(input.stdin);
    if (nativeSteps.length === 2 && nativeSteps[1][0] === "find" && nativeSteps[1][2] === "Rejected datetime" || nativeSteps.length === 2 && nativeSteps[1][0] === "fill" && nativeSteps[1][1] === "#readonly-date") {
      const success = defect === "rejected-fill-success";
      return { details: { resultCategory: success ? "success" : "failure", data: [
        { command: nativeSteps[0], success: true },
        { command: nativeSteps[1], success, error: "fill_value_not_retained: controlled value rejected" },
      ] } };
    }
    if (nativeSteps.length === 2 && nativeSteps[0][0] === "get" && ["eval", "screenshot", "pdf"].includes(nativeSteps[1][0])) {
      assert.equal(input.args.at(-1), "--bail", "page reverification and inspection must use fail-fast batches");
      const data = nativeSteps.map(command => ({ command, success: command[0] === "get" || defect === "unsafe-eval-success" && command[0] === "eval", error: defect === "wrong-refusal" ? "Unexpected command error" : "SENSITIVE_OUTPUT_UNSUPPORTED: sensitive input page" }));
      if (defect === "unsafe-artifact" && data[1].command[0] === "screenshot") writeFileSync(data[1].command[1], "unprotected artifact");
      return { details: { resultCategory: "failure", data } };
    }
    assert.equal(input.args.at(-1), "--bail");
    const steps = JSON.parse(input.stdin);
    const state = sessions.get(name) ?? { frame: "main", values: new Map(), sensitive: false };
    sessions.set(name, state);
    const data = [];
    for (const command of steps) {
      let result = {};
      if (command[0] === "open") state.sensitive = command[1].endsWith("/sensitive");
      if (command[0] === "frame") state.frame = command[1];
      if (command[0] === "fill") {
        state.values.set(`${state.frame}:${command[1]}`, command[2]); state.dateRoute = "direct";
        if (command[1] === "#controlled-timezone" && !(defect === "raw-clear-noevent" && command[2] === "")) state.timezoneState = command[2];
      }
      if (command[0] === "find") {
        assert.equal(command[1], "label"); assert.equal(command[3], "fill");
        const target = command[2] === "Controlled date" ? "#controlled-date" : command[2] === "Controlled datetime" ? "#controlled-datetime" : "#controlled-timezone";
        if (defect !== "find-date-value") state.values.set(`${state.frame}:${target}`, command[4]);
        state.dateRoute = "find-label";
      }
      if (command[0] === "snapshot") result = { refs, snapshot: state.sensitive ? defect === "sensitive-snapshot" ? "4000 0000 0000 0077" : "[redacted: cc-number]" : "ordinary page" };
      if (command[0] === "get") {
        if (command[1] === "title") result = { title: options.title };
        if (command[1] === "cdp-url") result = { cdpUrl: "ws://127.0.0.1/probe" };
        if (command[1] === "url") result = { url: options.url };
        if (command[1] === "value") {
          const sensitive = { "#cardnumber": "[redacted: cc-number]", "#exp-date": "[redacted: cc-exp]", "#cvc": "[redacted: cc-csc]", "#secret-password": "[redacted: password]", "#otp": "[redacted: one-time-code]", "#cardholder": "Public Test Name" };
          if (["#readonly-date", "#rejected-datetime"].includes(command[2])) state.values.set(`${state.frame}:${command[2]}`, defect === "rejected-value-mutated" ? "2030-01-01" : command[2] === "#readonly-date" ? "2026-10-02" : "2026-10-02T23:00");
          result = { value: state.sensitive ? defect === "sensitive-getter" && command[2] === "#cvc" ? "937" : sensitive[command[2]] : remote && defect === "remote-value" || defect === "date-value" && command[2] === "#controlled-date" ? "" : state.values.get(`${state.frame}:${command[2]}`) };
        }
        if (["text", "html"].includes(command[1]) && state.sensitive) result = { [command[1]]: defect === "sensitive-html" && command[1] === "html" ? '<input value="fixture-password-82">' : "[redacted: password]" };
      }
      if (command[0] === "eval") {
        result = { result: command[1] === "location.hostname" ? "localhost" : command[1].includes("controlled-state") ? { date: defect === "date-state" || defect === "find-date-state" && state.dateRoute === "find-label" || defect === "semantic-date-state" && state.dateRoute === "semantic" ? "2026-10-02" : state.values.get("main:#controlled-date"), datetime: state.values.get("main:#controlled-datetime") } : true };
        if (command[1].includes("controlled-timezone-state")) result.result = state.timezoneState;
        if (defect === "dynamic-realm" && state.frame === "#dynamic-frame") result.result = "127.0.0.1";
        if (defect === "static-realm" && !remote && state.frame.includes("Secure payment")) result.result = "127.0.0.1";
      }
      if (command[0] === "screenshot") writeFileSync(command[1], Buffer.from("89504e470d0a1a0a", "hex"));
      if (command[0] === "download") {
        assert.equal(command[1], "@e2", "download uses the live snapshot ref");
        writeFileSync(command[2], defect === "download-bytes" ? "wrong" : options.downloadContent);
      }
      data.push({ command, result, success: true });
    }
    if (defect === "truncated-batch") data.pop();
    if (defect === "failed-row") data[0].success = false;
    return { details: { resultCategory: "success", data, artifactVerification: { verified: defect !== "unverified-artifact" } } };
  } };
  return { options, tool, calls, closed };
}

test("complete native proof batches download and frames while retaining every result and artifact assertion", async (t) => {
  const f = fixture(t);
  const records = [];
  await probeBrowser(f.tool, { ...f.options, record: phase => records.push(phase) });
  const commands = records.filter(row => row.status === "running");
  assert.equal(commands.length, f.calls.length);
  const frameCommands = commands.filter(row => row.phase === 'download-and-frames');
  assert.equal(frameCommands.length, 1, 'sixteen steps cross the native wrapper boundary once');
  assert.equal(JSON.parse(frameCommands[0].command.stdin).length, 16, 'download, static frame and dynamic frame all remain in the proof');
  const recurring = commands.filter(row => row.command.args?.includes("batch"));
  assert.ok(recurring.length > 0);
  assert.ok(recurring.every(row => JSON.parse(row.command.stdin).length > 1), "recurring linear checks stay batched");
  assert.ok(commands.every(row => row.deadlineMs === 25000));
  assert.deepEqual(commands.map(row => row.command), f.calls.map(({ timeoutMs, ...input }) => input));
  assert.deepEqual(f.closed, ["attached", "owner"]);
});

for (const defect of ["raw-clear-noevent", "semantic-clear-noevent", "semantic-clear-noop", "semantic-unset-success", "date-value", "date-state", "find-date-value", "find-date-state", "semantic-date-value", "semantic-date-state", "rejected-fill-success", "rejected-value-mutated", "static-realm", "dynamic-realm", "remote-value", "download-bytes", "unverified-artifact", "truncated-batch", "failed-row", "attached-cleanup", "sensitive-snapshot", "sensitive-getter", "sensitive-html", "saved-sensitive-value", "unsafe-eval-success", "wrong-refusal", "unsafe-artifact"]) {
  test(`rejects ${defect} and still closes the owner`, async (t) => {
    const f = fixture(t, defect);
    await assert.rejects(probeBrowser(f.tool, f.options));
    assert.equal(f.closed.at(-1), "owner");
    if (["remote-value", "attached-cleanup"].includes(defect)) assert.deepEqual(f.closed, ["attached", "owner"]);
  });
}

test("failed isolated cleanup prevents continuing the proof", async (t) => {
  const f = fixture(t, "script-cleanup");
  await assert.rejects(probeBrowser(f.tool, f.options), /isolated probe browser must be closed/);
  assert.equal(f.calls.length, 1);
});


test('independent browser proofs run concurrently and join peer cleanup before propagating a failure', async () => {
  const events = [];
  let release, started;
  const peerStarted = new Promise(resolve => { started = resolve; });
  const peerRelease = new Promise(resolve => { release = resolve; });
  const result = settleBrowserProofs([
    async () => { await peerStarted; events.push('failed proof cleaned'); throw new Error('first proof rejected'); },
    async () => { events.push('peer started'); started(); await peerRelease; events.push('peer cleaned'); },
  ]);
  const outcome = result.then(() => 'passed', error => { events.push('failure propagated'); return error; });
  await peerStarted;
  await Promise.resolve();
  assert.equal(events.includes('failure propagated'), false, 'no release before the independent peer settles');
  release();
  const error = await outcome;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0].message, 'first proof rejected');
  assert.ok(events.indexOf('peer cleaned') < events.indexOf('failure propagated'));
});

test("unfinished download command is recorded before failure and owner cleanup", async t => {
  const f = fixture(t), records = [], execute = f.tool.execute;
  f.tool.execute = async (id, input) => {
    if (input.stdin && JSON.parse(input.stdin)[0]?.[0] === "download") {
      assert.equal(records.at(-1).status, "running");
      throw new Error("download command stalled");
    }
    return execute(id, input);
  };
  await assert.rejects(probeBrowser(f.tool, { ...f.options, record: row => records.push(row) }), /download command stalled/);
  const failed = records.find(row => row.status === "failed");
  assert.equal(failed.phase, "download-and-frames");
  assert.deepEqual(JSON.parse(failed.command.stdin)[0].slice(0, 2), ["download", "@e2"]);
  assert.equal(f.closed.at(-1), "owner");
});
