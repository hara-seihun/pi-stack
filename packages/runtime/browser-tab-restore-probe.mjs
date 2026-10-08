import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

export async function probeTabRestoration(tool, { url, statePath, record }) {
  const origin = new URL(url).origin;
  const account = "doctor-tab-account";
  const names = ["source", "replacement", "new-tab"].map(label => `doctor-tab-${label}-${randomUUID()}`);
  const owned = new Set();
  const execute = async (name, phase, steps, expected = "success") => {
    const input = { args: ["--session", name, "batch", "--bail"], stdin: JSON.stringify(steps), timeoutMs: 20000 };
    record({ phase, status: "running", deadlineMs: 25000, command: input });
    let timer;
    const started = performance.now();
    try {
      const answer = await Promise.race([
        tool.execute(randomUUID(), input, AbortSignal.timeout(25000)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${phase} exceeded subcommand deadline`)), 25000); }),
      ]);
      assert.equal(answer.details.resultCategory, expected, JSON.stringify(answer));
      assert.equal(answer.details.data.length, steps.length, `${phase}: every command must finish`);
      if (expected === "success") for (const row of answer.details.data) assert.equal(row.success, true, `${phase}: native command must succeed`);
      record({ phase, status: "completed", elapsedMs: Math.round(performance.now() - started) });
      return answer.details.data;
    } finally { clearTimeout(timer); }
  };
  const close = async name => {
    await execute(name, "tab-state-cleanup", [["close"]]);
    owned.delete(name);
  };
  try {
    owned.add(names[0]);
    await execute(names[0], "tab-state-capture", [
      ["open", url],
      ["eval", "sessionStorage.setItem('fixture-tab-auth', 'fixture-tab-token'); true"],
      ["state", "save-tab", statePath, account, origin, "120"],
    ]);
    assert.ok(existsSync(statePath), "authorized tab capsule must exist");
    assert.equal(statSync(statePath).mode & 0o077, 0, "tab auth state must be owner-private");
    await close(names[0]);
    for (const name of names.slice(1)) {
      owned.add(name);
      await execute(name, "tab-state-new-owner", [["open", "about:blank"]]);
      for (const [wrongAccount, wrongOrigin] of [["other-account", origin], [account, origin.replace("127.0.0.1", "localhost")]]) {
        const refused = await execute(name, "tab-state-mismatch-refusal", [
          ["get", "url"], ["state", "load-tab", statePath, wrongAccount, wrongOrigin],
        ], "failure");
        assert.equal(refused[0].success, true);
        assert.equal(refused[1].success, false, "wrong account/origin must not authorize tab restoration");
      }
      const restored = await execute(name, "tab-state-restored-startup", [
        ["state", "load-tab", statePath, account, origin], ["open", new URL("/tab-auth", url).href],
        ["get", "text", "#tab-startup"],
      ]);
      assert.equal(restored[2].result.text, "authorized-at-startup", "tab auth must be restored before app code runs");
      const newTab = await execute(name, "tab-state-restored-new-tab", [
        ["tab", "new", "about:blank"], ["state", "load-tab", statePath, account, origin],
        ["open", new URL("/tab-auth", url).href], ["get", "text", "#tab-startup"],
      ]);
      assert.equal(newTab[3].result.text, "authorized-at-startup", "each new tab must explicitly restore auth before startup");
      await close(name);
    }
  } finally {
    const failures = [];
    for (const name of owned) {
      try { await close(name); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "tab-state probe cleanup failed");
  }
}
