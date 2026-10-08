import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configuredAgentCapacity, type AgentCapacity } from "../agent-capacity.js";
import { openSqlite } from "../sqlite.js";
import { ThreadCapacityLedger } from "./capacity-ledger.js";
import type { Result } from "./contracts.js";

export interface NativeOwnerRecord { threadId: string; databasePath: string; unit: string; cgroup: string; bootId: string }
export type NativeOwnerAbsence = (owner: NativeOwnerRecord) => Promise<Result<boolean>>;
const failure = (message: string): Result<never> => ({ ok: false, error: { code: "unavailable", message } });

export const nativeOwnerAbsent: NativeOwnerAbsence = async owner => {
  try {
    if (!/^pi-native-[a-f0-9-]+\.service$/.test(owner.unit) || !owner.cgroup.startsWith("/user.slice/") || !owner.cgroup.endsWith(`/${owner.unit}`) || owner.cgroup.includes("..") || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.bootId)) return failure("Invalid native managed owner identity");
    if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== owner.bootId) return { ok: true, value: true };
    const shown = execFileSync("systemctl", ["--user", "show", owner.unit, "--property=LoadState,ActiveState"], { encoding: "utf8", timeout: 5000 });
    const properties = Object.fromEntries(shown.trim().split("\n").map(line => line.split("=")));
    if (properties.LoadState !== "not-found" && !["inactive", "failed"].includes(properties.ActiveState)) return { ok: true, value: false };
    try {
      const events = readFileSync(join("/sys/fs/cgroup", owner.cgroup, "cgroup.events"), "utf8");
      return { ok: true, value: events.split("\n").includes("populated 0") };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ok: true, value: true } : failure(String(error));
    }
  } catch (error) { return failure(`Native owner absence is unknown: ${String(error)}`); }
};

/** Only the recorded unit's absent cgroup proves its native execution and tool children stopped. */
export async function recoverNativeSessionOwners(directory: string, options: { capacity?: AgentCapacity; absent?: NativeOwnerAbsence; unit?: string; requireAbsent?: boolean } = {}): Promise<Result<void>> {
  let entries: import("node:fs").Dirent[];
  try {
    if (!lstatSync(directory).isDirectory()) return failure("Native owner root must be an actual directory");
    entries = readdirSync(directory, { withFileTypes: true });
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ok: true, value: undefined } : failure(String(error)); }
  for (const entry of entries) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name)) continue;
    if (!entry.isDirectory()) return failure(`Native owner directory must not be a link or other file: ${entry.name}`);
    const result = await recoverNativeSessionOwners(join(directory, entry.name), options);
    if (!result.ok) return result;
  }
  for (const entry of entries.filter(item => item.name.endsWith(".owner.json"))) {
    let owner: NativeOwnerRecord;
    try {
      if (!entry.isFile()) return failure(`Native owner record must be an actual file: ${entry.name}`);
      owner = JSON.parse(readFileSync(join(directory, entry.name), "utf8"));
      if (!owner || typeof owner.threadId !== "string" || typeof owner.databasePath !== "string" || owner.databasePath !== join(directory, entry.name.replace(/\.owner\.json$/, ".sqlite3")) || typeof owner.unit !== "string" || typeof owner.cgroup !== "string" || typeof owner.bootId !== "string" || !owner.cgroup.endsWith(`/${owner.unit}`) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.bootId)) return failure(`Invalid native owner record: ${entry.name}`);
      if (options.unit && owner.unit !== options.unit) continue;
      if (!lstatSync(owner.databasePath).isFile()) return failure("Native owner database must be an actual file");
    } catch (error) { return failure(String(error)); }
    let db: ReturnType<typeof openSqlite> | undefined;
    try {
      db = openSqlite(owner.databasePath);
      if (!db.prepare("SELECT 1 FROM thread_capacity WHERE state!='released' LIMIT 1").get()) continue;
      const absent = await (options.absent ?? nativeOwnerAbsent)(owner);
      if (!absent.ok) return absent;
      if (!absent.value) {
        if (options.requireAbsent) return failure("Native managed unit has not stopped yet; custody retained");
        continue;
      }
      const ledger = new ThreadCapacityLedger(db, options.capacity ?? configuredAgentCapacity());
      const interrupted = ledger.current(owner.threadId).some(row => !(db!.prepare("SELECT response FROM thread_request WHERE id=?").get(row.source_id) as { response: string | null } | undefined)?.response);
      const message = "Native managed unit stopped before its operation acknowledged completion; its callback cannot be replayed";
      db.exec("BEGIN IMMEDIATE");
      try {
        if (interrupted) {
          db.prepare("UPDATE thread_request SET response=? WHERE target=? AND kind='command' AND response IS NULL")
            .run(JSON.stringify({ ok: false, error: { code: "unavailable", message } }), owner.threadId);
          db.prepare("UPDATE thread SET state='idle',held=0,metadata=json_set(json_remove(metadata,'$.runnerReference','$.admissionWait'),'$.commandError',?) WHERE id=?").run(message, owner.threadId);
        } else db.prepare("UPDATE thread SET state='idle',metadata=json_remove(metadata,'$.runnerReference','$.admissionWait') WHERE id=?").run(owner.threadId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); return failure(String(error)); }
      const result = await ledger.release(owner.threadId);
      if (!result.ok) return result;
    } catch (error) { return failure(`Native owner recovery failed: ${String(error)}`); }
    finally { db?.close(); }
  }
  return { ok: true, value: undefined };
}
