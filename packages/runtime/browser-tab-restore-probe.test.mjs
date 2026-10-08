import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeTabRestoration } from "./browser-tab-restore-probe.mjs";

function fixture(t, defect) {
  const directory = mkdtempSync(join(tmpdir(), "tab-restore-proof-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const sessions = new Map(), closed = [], calls = [];
  let capsule;
  const tool = { async execute(_id, input) {
    calls.push(input);
    const name = input.args[1], rows = [], state = sessions.get(name) ?? { auth: false };
    sessions.set(name, state);
    let failed = false;
    for (const command of JSON.parse(input.stdin)) {
      let result = {}, success = true;
      if (command[0] === "open") {
        state.url = command[1];
        state.verified = true;
        state.startup = state.auth ? "authorized-at-startup" : "unauthorized-at-startup";
      }
      if (command[0] === "eval") { state.auth = true; state.verified = false; }
      if (command[0] === "tab") { state.auth = false; state.verified = false; }
      if (command[0] === "get" && command[1] === "url") state.verified = true;
      if (command[0] === "state") assert.equal(state.verified, true, "state operations require a current URL checkpoint after transitions");
      if (command[0] === "state" && command[1] === "save-tab") {
        capsule = { account: command[3], origin: command[4] };
        writeFileSync(command[2], "synthetic private capsule", { mode: 0o600 });
        if (defect === "public-capsule") chmodSync(command[2], 0o644);
      }
      if (command[0] === "state" && command[1] === "load-tab") {
        const match = !command[2].endsWith(".absent") && command[3] === capsule.account && command[4] === capsule.origin;
        success = match || defect === "mismatch-accepted";
        if (success && defect !== "late-restore" && defect !== "new-tab-unrestored" ) state.auth = true;
        if (defect === "new-tab-unrestored" && !state.url?.endsWith("/tab-auth")) state.auth = true;
      }
      if (command[0] === "get") result = command[1] === "url" ? { url: state.url } : { text: state.startup };
      if (command[0] === "close") { closed.push(name); sessions.delete(name); }
      rows.push({ command, result, success });
      if (!success) { failed = true; break; }
    }
    return { details: { resultCategory: failed ? "failure" : "success", data: rows } };
  } };
  return { tool, closed, calls, options: { url: "http://127.0.0.1:1234/", statePath: join(directory, "capsule.json"), record() {} } };
}

test("authorized restoration proves startup in replacement owners and new tabs", async t => {
  const f = fixture(t);
  await probeTabRestoration(f.tool, f.options);
  assert.equal(new Set(f.closed).size, 3, "all three owned browser sessions are closed");
  assert.equal(f.calls.filter(call => JSON.parse(call.stdin).some(command => command[0] === "tab")).length, 2);
});
for (const defect of ["public-capsule", "mismatch-accepted", "late-restore", "new-tab-unrestored"]) {
  test(`rejects ${defect} and cleans up owned sessions`, async t => {
    const f = fixture(t, defect);
    await assert.rejects(probeTabRestoration(f.tool, f.options));
    assert.ok(f.closed.length > 0);
  });
}
