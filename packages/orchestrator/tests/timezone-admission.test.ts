import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { writeTimezoneProjection } from "../src/person-timezone.js";

it("retains queued receipts before capacity/native custody while a timezone projection is missing or updating", async () => {
  const root = mkdtempSync(join(tmpdir(), "timezone-admission-")), file = join(root, "timezone.json");
  const openSession = vi.fn(async () => { throw new Error("No native custody admitted"); });
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite3"), sessionsDir: root, openSession,
    environment: () => ({ PI_PERSON_TIMEZONE_FILE: file }), capacity: { mode: "unmanaged" } });
  const internals = service as any;
  const capacity = vi.spyOn(internals, "recoverUnassignedCapacity").mockResolvedValue(false);
  try {
    expect(service.importThread({ id: "thread", cwd: root, title: "Queued", sessionFile: join(root, "session.jsonl"),
      settings: { model: "pi/native", thinkingLevel: "off", speed: "standard" } }).ok).toBe(true);
    expect(service.importMessage({ id: "receipt", threadId: "thread", text: "retained raw input" }).ok).toBe(true);
    const before = service.pending("thread");
    await internals.drain("thread");
    expect(service.get("thread")?.metadata?.admissionWait).toMatchObject({ code: "unavailable" });
    expect(service.pending("thread")).toEqual(before);
    expect(service.settlements()).toMatchObject({ ok: true, value: { items: [] } });
    expect(capacity).not.toHaveBeenCalled(); expect(openSession).not.toHaveBeenCalled();
    writeTimezoneProjection(file, { version: 1, state: "updating" });
    await internals.drain("thread");
    expect(service.pending("thread")).toEqual(before); expect(capacity).not.toHaveBeenCalled();
    writeTimezoneProjection(file, { version: 1, state: "ready", timezone: null });
    await internals.drain("thread");
    expect(capacity).toHaveBeenCalledOnce();
    expect(service.pending("thread")).toEqual(before);
  } finally { vi.restoreAllMocks(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
