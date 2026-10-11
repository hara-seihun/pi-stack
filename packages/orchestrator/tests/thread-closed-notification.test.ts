import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";

for (const held of [false, true]) for (const closeDuringLookup of [false, true]) test(`closed original receives one cross-owner Root notification without execution (held: ${held}, lookup close: ${closeDuringLookup})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "closed-notification-"));
  let executions = 0;
  const create = () => new ThreadService({ databasePath: ":memory:", sessionsDir: root, capacity: { mode: "unmanaged" },
    openSession: async () => { executions++; throw new Error("Closed recipient must not execute"); } });
  const person = create(), fleet = create();
  const directory = new ThreadDirectory({ id: "person", api: person }, [{ id: "fleet", api: fleet }]);
  person.setDirectory(directory);
  let retainedHeld = held;
  fleet.setDirectory(new Proxy(directory, { get(target, key) {
    if (key === "list") return async (input: Parameters<ThreadDirectory["list"]>[0]) => {
      if (closeDuringLookup && input?.id === "kenan-root") {
        expect(fleet.update("original", { archived: true }).ok).toBe(true);
        retainedHeld = fleet.get("original")!.held;
      }
      return target.list(input);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } }));
  try {
    expect(fleet.importState([{ id: "original", title: "Original", cwd: root, sessionFile: join(root, "original.jsonl"),
      settings: { model: "sol", thinkingLevel: "high", speed: "standard" }, held, metadata: { archived: !closeDuringLookup } }], []).ok).toBe(true);
    expect((await person.start()).ok).toBe(true);
    expect((await fleet.start()).ok).toBe(true);
    const input = { requestId: "consent:original-request:reply", threadId: "original", senderId: "kenan-root",
      text: "Chosen fixture reply", source: "notification" as const, delivery: "steer" as const };
    const first = await directory.send(input), retry = await directory.send(input);
    expect(first).toMatchObject({ ok: true });
    expect(retry).toEqual(first);
    expect(fleet.pending("original")).toHaveLength(1);
    expect(person.pending("original")).toHaveLength(0);
    expect(fleet.get("original")).toMatchObject({ state: "idle", held: retainedHeld, metadata: { archived: true } });
    expect(await directory.send({ ...input, requestId: "explicit-closed", source: "explicit" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    await Promise.resolve();
    expect(executions).toBe(0);
  } finally { await person.close(); await fleet.close(); rmSync(root, { recursive: true, force: true }); }
});
