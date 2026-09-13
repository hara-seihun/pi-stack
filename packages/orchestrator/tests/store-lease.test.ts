import { expect, it } from "vitest";
import { Store } from "../src/store.js";
import { accountCapacity } from "../src/policy.js";
import { loadConfig } from "../src/config.js";

it("recovers host interruptions with custody while keeping actual operator aborts terminal", () => {
  const store=Store.open(":memory:");
  try {
    store.upsertAccount({id:"a",provider:"anthropic"});
    const [id]=store.createRuns({count:1,source:"direct",prompt:"research",cwd:"/tmp",profile:"fable",budget:"force",core:"codex"});
    store.assignRun(id!,{accountId:"a",provider:"anthropic",model:"claude-fable-5-1",thinking:"max",unit:"worker",releasePath:"/release/first"});
    store.updateRun(id!,{nativeSessionId:"native",state:"aborted",failureKind:"operator",result:"aborted"});
    expect(store.recoverInterruptedRun(id!,"/release/next",1234)).toBe(true);
    expect(store.run(id!)).toMatchObject({state:"starting",nativeSessionId:"native",accountId:"a",thinking:"max",releasePath:"/release/next"});
    expect(JSON.parse(store.control(`run-interruption:${id}:1234`)!)).toMatchObject({result:"aborted",releasePath:"/release/first"});
    store.updateRun(id!,{state:"failed",failureKind:"infrastructure",result:"TypeError: fetch failed"});
    expect(store.recoverInterruptedRun(id!,"/release/next",1235)).toBe(true);
    store.updateRun(id!,{state:"aborted",failureKind:"operator",result:"aborted"});
    store.setControl(`abort:${id}`,"abort");
    expect(store.recoverInterruptedRun(id!,"/release/next")).toBe(false);
  } finally { store.close(); }
});

it("continues only provider-output-limited native runs and preserves their assignment and failure receipt", () => {
  const store=Store.open(":memory:");
  try {
    store.upsertAccount({id:"a",provider:"anthropic"});
    const [id]=store.createRuns({count:1,source:"direct",prompt:"research",cwd:"/tmp",profile:"fable",budget:"force",core:"codex"});
    store.assignRun(id!,{accountId:"a",provider:"anthropic",model:"claude-fable-5-1",thinking:"max",unit:"worker",releasePath:"/release/first"});
    store.updateRun(id!,{nativeSessionId:"native",state:"failed",failureKind:"infrastructure",result:"Error: Incomplete response returned, reason: max_output_tokens"});
    const before=store.run(id!)!;
    expect(store.continueOutputLimitedRun(id!,"/release/next",1234)).toBe(true);
    expect(store.run(id!)).toMatchObject({state:"starting",nativeSessionId:"native",accountId:"a",model:before.model,thinking:"max",releasePath:"/release/next"});
    expect(JSON.parse(store.control(`run-output-limit:${id}:1234`)!)).toMatchObject({result:before.result,releasePath:"/release/first"});
    expect(store.continueOutputLimitedRun(id!,"/release/next")).toBe(false);
    store.updateRun(id!,{state:"failed",result:"Error: Incomplete response returned, reason: max_output_tokens"});
    store.setControl(`abort:${id}`,"abort");
    expect(store.continueOutputLimitedRun(id!,"/release/next")).toBe(false);
  } finally { store.close(); }
});

it("keeps completed lease exposure across idle reactivation and account changes without moving the live ID", () => {
  const store = Store.open(":memory:");
  const start = 1_800_000_000_000, hour = 3_600_000;
  const at = (hours: number) => start + hours * hour;
  const id = "interactive:retained-child";
  const current = () => store.db.prepare("SELECT * FROM lease WHERE id=?").get(id);
  try {
    for (const account of ["a", "b"]) store.upsertAccount({ id: account, provider: "openai-codex", concurrency: 100 });
    store.createLease(id, "a", "interactive", undefined, at(0));
    store.createLease(id, "a", "interactive", undefined, at(0.25));
    expect(current()).toMatchObject({ started_at: at(0), heartbeat_at: at(0.25), ended_at: null });
    store.endLease(id, at(0.5));
    store.createLease(id, "a", "interactive", undefined, at(1));
    expect(current()).toMatchObject({ started_at: at(1), heartbeat_at: at(1), ended_at: null });

    expect(() => store.createLease(id, "missing-account", "interactive", undefined, at(1.5))).toThrow();
    expect(current()).toMatchObject({ account_id: "a", started_at: at(1), ended_at: null });
    store.createLease(id, "b", "interactive", undefined, at(2));
    expect(store.activeSessionLeases(undefined, 120_000, at(2))).toMatchObject([{ id, account_id: "b" }]);
    store.endLease(id, at(3));
    store.createLease(id, "a", "interactive", undefined, at(3));
    store.createLease(id, "a", "interactive", undefined, at(4));
    expect(store.activeSessionLeases(undefined, 120_000, at(4))).toMatchObject([
      { id, account_id: "a", started_at: at(3), heartbeat_at: at(4), ended_at: null },
    ]);
    expect(store.db.prepare("SELECT account_id,kind,run_id,started_at,ended_at FROM lease ORDER BY started_at").all()).toEqual([
      { account_id: "a", kind: "interactive", run_id: null, started_at: at(0), ended_at: at(0.5) },
      { account_id: "a", kind: "interactive", run_id: null, started_at: at(1), ended_at: at(2) },
      { account_id: "b", kind: "interactive", run_id: null, started_at: at(2), ended_at: at(3) },
      { account_id: "a", kind: "interactive", run_id: null, started_at: at(3), ended_at: null },
    ]);

    store.recordMeter("a", "codex-5h", 10, at(5), at(0));
    store.recordMeter("a", "codex-5h", 20, at(5), at(4));
    const config = { ...loadConfig("/definitely/missing/pi-orchestrator-config.json"), backgroundSpendFraction: 0.8 };
    expect(accountCapacity(store, "a", "background", config, at(4))).toMatchObject({
      sessions: 13,
      reason: "codex-5h: 60.00%/h available, 4.40% per session-hour",
    });
  } finally {
    store.close();
  }
});
