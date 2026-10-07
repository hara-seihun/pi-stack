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
    assert.equal(input.args.at(-1), "--bail");
    const steps = JSON.parse(input.stdin);
    const state = sessions.get(name) ?? { frame: "main", values: new Map() };
    sessions.set(name, state);
    const data = [];
    for (const command of steps) {
      let result = {};
      if (command[0] === "frame") state.frame = command[1];
      if (command[0] === "fill") state.values.set(`${state.frame}:${command[1]}`, command[2]);
      if (command[0] === "snapshot") result = { refs };
      if (command[0] === "get") {
        if (command[1] === "title") result = { title: options.title };
        if (command[1] === "cdp-url") result = { cdpUrl: "ws://127.0.0.1/probe" };
        if (command[1] === "url") result = { url: options.url };
        if (command[1] === "value") result = { value: remote && defect === "remote-value" || defect === "date-value" && command[2] === "#controlled-date" ? "" : state.values.get(`${state.frame}:${command[2]}`) };
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

test("complete native proof keeps linear batches and exact download/frame subcommand custody", async (t) => {
  const f = fixture(t);
  const records = [];
  await probeBrowser(f.tool, { ...f.options, record: phase => records.push(phase) });
  const commands = records.filter(row => row.status === "running");
  assert.equal(commands.length, f.calls.length);
  const frameCommands = commands.filter(row => row.phase.startsWith("download-and-frames/"));
  assert.ok(frameCommands.length > 0);
  assert.ok(frameCommands.every(row => JSON.parse(row.command.stdin).length === 1), "troubleshooting commands each have their own bounded custody");
  const recurring = commands.filter(row => row.command.args?.includes("batch") && !row.phase.startsWith("download-and-frames/"));
  assert.ok(recurring.length > 0);
  assert.ok(recurring.every(row => JSON.parse(row.command.stdin).length > 1), "recurring linear checks stay batched");
  assert.ok(commands.every(row => row.deadlineMs === 25000));
  assert.deepEqual(commands.map(row => row.command), f.calls.map(({ timeoutMs, ...input }) => input));
  assert.deepEqual(f.closed, ["attached", "owner"]);
});

for (const defect of ["date-value", "date-state", "static-realm", "dynamic-realm", "remote-value", "download-bytes", "unverified-artifact", "truncated-batch", "failed-row", "attached-cleanup"]) {
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
  assert.equal(failed.phase, "download-and-frames/0:download");
  assert.deepEqual(JSON.parse(failed.command.stdin)[0].slice(0, 2), ["download", "@e2"]);
  assert.equal(f.closed.at(-1), "owner");
});
