import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pro-questions-test-"));
process.env.AGENT_ORCHESTRATOR_DATA = temporary;
const tool = new URL("./pro-questions.mjs", import.meta.url).pathname;
const db = new DatabaseSync(path.join(temporary, "orchestrator.sqlite3"));
db.exec("CREATE TABLE run (id TEXT PRIMARY KEY, status TEXT, summary TEXT)");
db.close();

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function invoke(args, environment = {}) {
  try {
    const stdout = execFileSync("node", [tool, ...args], {
      env: { ...process.env, ...environment }, encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? "") };
  }
}

test("questions move queue -> claimed -> done/requeue on run outcome", () => {
  const promptFile = path.join(temporary, "q.md");
  fs.writeFileSync(promptFile, "Prove the exact theorem T.");
  assert.equal(invoke(["add", promptFile, "--id", "theorem-t"]).code, 0);
  // Duplicate ids are rejected.
  assert.notEqual(invoke(["add", promptFile, "--id", "theorem-t"]).code, 0);

  // Claim requires a run id, prints the literal prompt.
  assert.equal(invoke(["claim"]).code, 2);
  const claimed = invoke(["claim"], { ORCHESTRATOR_RUN_ID: "run-1" });
  assert.equal(claimed.code, 0);
  assert.equal(claimed.stdout, "Prove the exact theorem T.");
  // Nothing left to claim.
  assert.equal(invoke(["claim"], { ORCHESTRATOR_RUN_ID: "run-2" }).code, 1);

  // A failed run (no summary) requeues the question.
  const database = new DatabaseSync(path.join(temporary, "orchestrator.sqlite3"));
  database.prepare("INSERT INTO run VALUES('run-1','incomplete',NULL)").run();
  database.close();
  assert.equal(invoke(["reap"]).code, 0);
  assert.ok(fs.existsSync(path.join(temporary, "pro/questions/queue/theorem-t.md")));

  // A verified run (summary recorded) completes the question.
  const again = invoke(["claim"], { ORCHESTRATOR_RUN_ID: "run-3" });
  assert.equal(again.code, 0);
  const database2 = new DatabaseSync(path.join(temporary, "orchestrator.sqlite3"));
  database2.prepare("INSERT INTO run VALUES('run-3','incomplete','verified response text')").run();
  database2.close();
  invoke(["reap"]);
  assert.ok(fs.existsSync(path.join(temporary, "pro/questions/done/theorem-t.run-3.md")));
});
