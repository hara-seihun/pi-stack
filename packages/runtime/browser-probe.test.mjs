import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeBrowser } from "./browser-probe.mjs";

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
    const name = input.args[input.args.indexOf("--session") + 1];
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
      if (command[0] === "fill") state.values.set(`${state.frame}:${command[1]}`, command[2]);
      if (command[0] === "snapshot") result = { refs, snapshot: state.sensitive ? defect === "sensitive-snapshot" ? "4000 0000 0000 0077" : "[redacted: cc-number]" : "ordinary page" };
      if (command[0] === "get") {
        if (command[1] === "title") result = { title: options.title };
        if (command[1] === "cdp-url") result = { cdpUrl: "ws://127.0.0.1/probe" };
        if (command[1] === "url") result = { url: options.url };
        if (command[1] === "value") {
          const sensitive = { "#cardnumber": "[redacted: cc-number]", "#exp-date": "[redacted: cc-exp]", "#cvc": "[redacted: cc-csc]", "#secret-password": "[redacted: password]", "#otp": "[redacted: one-time-code]", "#cardholder": "Public Test Name" };
          result = { value: state.sensitive ? defect === "sensitive-getter" && command[2] === "#cvc" ? "937" : sensitive[command[2]] : remote && defect === "remote-value" || defect === "date-value" && command[2] === "#controlled-date" ? "" : state.values.get(`${state.frame}:${command[2]}`) };
        }
        if (["text", "html"].includes(command[1]) && state.sensitive) result = { [command[1]]: defect === "sensitive-html" && command[1] === "html" ? '<input value="fixture-password-82">' : "[redacted: password]" };
      }
      if (command[0] === "eval") {
        result = { result: command[1] === "location.hostname" ? "localhost" : command[1].includes("controlled-state") ? { date: defect === "date-state" ? "2026-10-02" : state.values.get("main:#controlled-date"), datetime: state.values.get("main:#controlled-datetime") } : true };
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

test("complete native proof uses bounded batches and closes both named sessions", async (t) => {
  const f = fixture(t);
  await probeBrowser(f.tool, f.options);
  assert.equal(f.calls.length, 12, "linear checks must not regress to per-command wrapper dispatch");
  assert.deepEqual(f.closed, ["attached", "owner"]);
});

for (const defect of ["date-value", "date-state", "static-realm", "dynamic-realm", "remote-value", "download-bytes", "unverified-artifact", "truncated-batch", "failed-row", "attached-cleanup", "sensitive-snapshot", "sensitive-getter", "sensitive-html", "saved-sensitive-value", "unsafe-eval-success", "wrong-refusal", "unsafe-artifact"]) {
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
