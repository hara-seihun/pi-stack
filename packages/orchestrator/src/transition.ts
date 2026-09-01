import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { catalogModel } from "./catalog.js";
import { Store } from "./store.js";

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
}

export function transitionLedger(path: string): void {
  const old = new DatabaseSync(path);
  old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
    old.close();
    return;
  }
  if (!old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task'").get()) {
    old.close();
    throw new Error("ledger is neither the previous nor current orchestrator schema");
  }
  const replacement = `${path}.replacement`;
  rmSync(replacement, { force: true });
  const next = Store.open(replacement);
  try {
    for (const row of old.prepare("SELECT * FROM account ORDER BY id").all() as any[]) {
      if (!["openai-codex", "anthropic"].includes(row.provider)) continue;
      next.upsertAccount({
        id: row.id,
        provider: row.provider,
        label: row.label ?? undefined,
        enabled: true,
        concurrency: 4,
      });
      if (row.cooldown_until) next.setCooldown(row.id, Number(row.cooldown_until));
    }
    const supported = new Set(next.accounts().map((account) => account.id));
    for (const row of old.prepare(`SELECT * FROM meter_reading m WHERE rowid IN (
      SELECT rowid FROM meter_reading x WHERE x.account_id=m.account_id AND x.meter_id=m.meter_id ORDER BY at DESC LIMIT 96
    ) ORDER BY at`).all() as any[]) {
      if (supported.has(row.account_id)) next.recordMeter(row.account_id,row.meter_id,Number(row.used_percent),row.reset_at??undefined,Number(row.at));
    }
    for (const row of old.prepare("SELECT key,value FROM control").all() as any[]) {
      if (row.key === "launches" || String(row.key).startsWith("boost:") || String(row.key).startsWith("complete:")) {
        next.setControl(row.key,row.value);
      }
    }
    const tasks = old.prepare("SELECT * FROM task").all() as any[];
    next.reconcileLanes(tasks.filter((task) => !task.team).map((task) => ({
      id: task.id,
      prompt: task.prompt ?? "",
      cwd: task.cwd ?? process.cwd(),
      profile: "standard",
      weight: Number(task.share ?? 1),
      fixedDemand: task.demand_constant == null ? undefined : Number(task.demand_constant),
      priority: Math.round(Number(task.share ?? 1)),
      doctrineUrl: task.doctrine_url ?? undefined,
      openingProbe: task.opening_probe ?? undefined,
    })));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const roomByTask = new Map<string,string>();
    for (const task of tasks.filter((candidate) => candidate.team)) {
      const team = JSON.parse(task.team);
      const id = crypto.randomUUID();
      const complete = next.control(`complete:${task.id}`) !== undefined;
      const roomNote="This is a peer room. Read room_feed and use room_post or room_message to coordinate. The old pi-orchestrator complete, reopen, and end_shift commands mentioned below no longer exist. Any member may call room_close once the final state is in durable custody, or room_leave when their own shift is done.\n\n";
      next.db.prepare(`INSERT INTO room(id,name,prompt,coordinator_prompt,cwd,profile,budget,desired_members,closed_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'standard',?,?,?,?,?)`).run(id,task.id,roomNote+(task.prompt??""),team.supervisorPrompt?roomNote+team.supervisorPrompt:null,task.cwd??process.cwd(),task.ignore_capacity?"force":"background",complete?0:["dci-finish","ci-finish"].includes(task.id)?20:Number(team.workers)+1,complete?Date.now():null,Number(task.created_at),Date.now());
      roomByTask.set(task.id,id);
    }
    const runColumns = columns(old,"run");
    const sessionFiles = new Map<string,string>();
    if (old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_session'").get()) {
      for (const row of old.prepare("SELECT run_id,session_file FROM run_session WHERE session_file IS NOT NULL ORDER BY created_at").all() as any[]) sessionFiles.set(row.run_id,row.session_file);
    }
    const insert = next.db.prepare(`INSERT INTO run(id,source,source_id,room_id,member_name,prompt,cwd,profile,budget,account_id,provider,model,thinking,session_file,state,failure_kind,result,created_at,started_at,updated_at,progress_at,ended_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of old.prepare("SELECT * FROM run ORDER BY started_at").all() as any[]) {
      const task = taskById.get(row.task_id);
      const roomId = roomByTask.get(row.task_id);
      const active = row.state === "running" || row.state === "pending";
      const model = catalogModel(row.model);
      insert.run(row.id,roomId?"room":"lane",roomId??row.task_id,roomId??null,row.team_role?`${row.team_role}-${Number(row.team_slot??0)+1}`:null,task?.prompt??`Recovered run ${row.id}`,task?.cwd??process.cwd(),model?.id??"standard",task?.ignore_capacity?"force":"background",active||!supported.has(row.account_id)?null:row.account_id,active||!supported.has(row.account_id)?null:row.provider,active?null:row.model,active?null:row.thinking,sessionFiles.get(row.id)??(runColumns.has("session_id")?null:null),active?"queued":row.state==="error"?"failed":row.state,row.state==="error"?"task":row.state==="aborted"?"infrastructure":null,row.detail??null,Number(row.started_at),row.claimed_at??row.started_at,Number(row.ended_at??row.heartbeat_at??row.started_at),row.progress_at??row.heartbeat_at??row.started_at,row.ended_at??null);
    }
    if (old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_message'").get()) {
      for (const row of old.prepare("SELECT * FROM run_message WHERE delivered_at IS NULL ORDER BY id").all() as any[]) {
        const target = next.run(row.run_id);
        if (!target?.roomId) continue;
        next.postMessage({roomId:target.roomId,senderRunId:row.sender_run_id??undefined,targetRunId:row.run_id,body:row.text,wake:true},Number(row.created_at));
      }
    }
    const usageHasRun = columns(old,"usage_event").has("run_id");
    const usage = old.prepare(`SELECT account_id,(at/3600000)*3600000 hour,source,${usageHasRun?"run_id":"NULL"} run_id,NULL model,SUM(tokens) tokens FROM usage_event GROUP BY account_id,hour,source,run_id`).all() as any[];
    const usageInsert = next.db.prepare("INSERT OR REPLACE INTO usage_hour VALUES(?,?,?,?,?,?)");
    for (const row of usage) if (supported.has(row.account_id)) usageInsert.run(row.account_id,row.hour,row.source,row.run_id??"",row.model??"",row.tokens);
  } finally {
    next.close();
    old.close();
  }
  const removed = `${path}.removed`;
  rmSync(removed,{force:true});
  renameSync(path,removed);
  renameSync(replacement,path);
  rmSync(removed,{force:true});
  rmSync(`${removed}-wal`,{force:true});
  rmSync(`${removed}-shm`,{force:true});
  if (!existsSync(path)) throw new Error("transition did not publish the replacement ledger");
}
