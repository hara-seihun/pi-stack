import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roomAudienceResolver } from "../src/core/room-audience.js";

test("the canonical room attestation reads the current complete roster and never downgrades", () => {
  const directory = mkdtempSync(join(tmpdir(), "core-room-audience-"));
  const path = join(directory, "rooms.sqlite3");
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE rooms(id TEXT,owner TEXT,members TEXT,ready INTEGER)");
    db.query("INSERT INTO rooms VALUES(?,?,?,?)").run("room", "pi-rooms", JSON.stringify([{ user: "alice" }, { user: "bob" }]), 1);
    const resolver = roomAudienceResolver(path, "pi-rooms");
    expect(resolver("alice", "room")).toBeUndefined();
    expect(resolver("pi-rooms", "room")).toEqual({ roomId: "room", people: ["alice", "bob"] });
    db.query("UPDATE rooms SET members=?").run(JSON.stringify([{ user: "alice" }, { user: "carol" }]));
    expect(resolver("pi-rooms", "room")?.people).toEqual(["alice", "carol"]);
    db.query("UPDATE rooms SET ready=0").run();
    expect(() => resolver("pi-rooms", "room")).toThrow();
    expect(() => resolver("pi-rooms", "absent")).toThrow();
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
