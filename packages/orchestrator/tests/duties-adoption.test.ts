import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { WatchList } from "../src/threads/watch-list.js";
import { adoptMarkdownDuties } from "../src/core/duties.js";

it("writes exact held duty custody before retirement and resumes a partially retired import idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "markdown-duties-"));
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" }, openSession: vi.fn() });
  const db = new DatabaseSync(join(root, "threads.sqlite"));
  try {
    const ids: string[] = [];
    for (const number of [1, 2]) {
      const created = await service.spawn({ requestId: `worker-${number}`, cwd: root, title: `Duty ${number}` });
      if (!created.ok) throw new Error(created.error.message);
      ids.push(created.value.id);
      db.prepare("UPDATE thread SET held=1 WHERE id=?").run(created.value.id);
      db.prepare("INSERT INTO thread_wake(thread_id,generation,data) VALUES(?,?,?)").run(created.value.id, `generation-${number}`,
        JSON.stringify({ reason: "Check the business", cadenceMs: 60_000, nextDueAt: number, lastMessageId: `occurrence-${number}` }));
      await service.send({ requestId: `occurrence-${number}`, threadId: created.value.id, text: "Accepted duty occurrence", source: "notification" });
    }
    const path = join(root, "notes", "duties.md");
    const original = service.adoptWakeDuty.bind(service);
    let calls = 0;
    vi.spyOn(service, "adoptWakeDuty").mockImplementation((id, receipt) => {
      expect(readFileSync(path, "utf8")).toContain(receipt);
      if (++calls === 2) return { ok: false, error: { code: "unavailable", message: "Simulated interrupted retirement" } };
      return original(id, receipt);
    });
    const failed = adoptMarkdownDuties({ service, path, uid: process.getuid!(), gid: process.getgid!() });
    expect(failed.ok).toBe(false);
    expect(service.exportWakeDuties()).toHaveLength(1);
    const snapshot = readFileSync(path, "utf8");
    const completed = adoptMarkdownDuties({ service, path, uid: process.getuid!(), gid: process.getgid!() });
    if (!completed.ok) throw new Error(completed.error.message);
    expect(completed.value.wakeCount).toBe(2);
    expect([...completed.value.pendingOccurrenceIds].sort()).toEqual(["occurrence-1", "occurrence-2"]);
    expect(readFileSync(path, "utf8")).toBe(snapshot);
    expect(service.exportWakeDuties()).toHaveLength(0);
    for (const id of ids) expect(service.get(id)?.held).toBe(true);
    expect(service.pending(ids[0]!).map(message => message.id)).toEqual(["occurrence-1"]);
  } finally { db.close(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});

describe("watch Markdown adoption", () => {
  it("preserves existing notes, watch requests and pending spool without dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "markdown-watch-"));
    const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" }, openSession: vi.fn() });
    const spawn = vi.fn();
    const watch = new WatchList({ databasePath: join(root, "watch.sqlite"), threads: { spawn, list: vi.fn(), questions: vi.fn() }, placement: vi.fn(), checkOutcome: vi.fn(), onError: vi.fn() });
    const db = new DatabaseSync(join(root, "watch.sqlite"));
    try {
      db.prepare("INSERT INTO watch_item(id,body) VALUES(?,?)").run("watch-3", JSON.stringify({ id: "watch-3", what: "Check exchange", why: "Needed", nextDueAt: 3, addedBy: "unknown", createdAt: 1, updatedAt: 1 }));
      db.prepare("INSERT INTO watch_wake(id,input) VALUES(?,?)").run("check-3", JSON.stringify({ id: "check-3", requestId: "watch-wake:check-3", cwd: root }));
      const path = join(root, "duties.md"); writeFileSync(path, "# Person's notes\n\nKeep this paragraph.\n");
      const adopted = adoptMarkdownDuties({ service, watch, path, uid: process.getuid!(), gid: process.getgid!() });
      if (!adopted.ok) throw new Error(adopted.error.message);
      const body = readFileSync(path, "utf8");
      expect(body).toContain("Keep this paragraph.");
      expect(body).toContain('"unknown":null');
      expect(adopted.value.pendingOccurrenceIds).toEqual(["check-3"]);
      expect(watch.exportDuties().pendingOccurrences[0]!.id).toBe("check-3");
      expect(spawn).not.toHaveBeenCalled();
      expect(adoptMarkdownDuties({ service, watch, path, uid: process.getuid!(), gid: process.getgid!() })).toEqual(adopted);
      expect(readFileSync(path, "utf8")).toBe(body);
    } finally { db.close(); await watch.close(); await service.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
