import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineImages } from "./inline-images";
import { InlineImages as Registry } from "../../../packages/orchestrator/src/core/image-registry";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remote-image-client-"));
  const db = new Database(join(root, "supervisor.sqlite3"));
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE thread_views(id TEXT PRIMARY KEY); INSERT INTO thread_views VALUES('thread')");
  new Registry(db, join(root, "images"), async () => { throw new Error("Remote cannot generate"); }, () => {});
  return { db, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Remote kill/unconfirmed delivery preserves exact image message in a durable outbox", async () => {
  const f = fixture();
  const delivered: unknown[] = [];
  let available = false;
  const transport = async (input: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init!.headers).get("authorization")).toBeNull();
    if (String(input).endsWith("/accept")) {
      delivered.push(JSON.parse(String(init!.body)));
      if (!available) throw new Error("Lost core acceptance response");
      return Response.json({ ok: true, value: { version: 1, images: [] } });
    }
    return Response.json({ ok: true, value: { snapshots: {}, errors: [] } });
  };
  const config = { url: "http://127.0.0.1:8791", scopeId: "person" };
  const messages: Array<string | null> = [];
  const client = new InlineImages(f.db, config, () => {}, message => messages.push(message), transport as typeof fetch);
  const text = '<pi-remote-image id="request" prompt="draw" />';
  try {
    expect(client.accept("thread", "native-message", text).ok).toBe(true);
    expect((await client.start()).ok).toBe(false);
    await client.close();
    expect(f.db.query("SELECT state FROM core_image_outbox").get()).toEqual({ state: "pending" });
    available = true;
    const replacement = new InlineImages(f.db, config, () => {}, message => messages.push(message), transport as typeof fetch);
    try {
      expect((await replacement.start()).ok).toBe(true);
      expect(delivered).toEqual([{ threadId: "thread", messageKey: "native-message", text }, { threadId: "thread", messageKey: "native-message", text }]);
      expect(f.db.query("SELECT * FROM core_image_outbox").all()).toEqual([]);
      expect(replacement.snapshot("thread").version).toBe(1);
    } finally { await replacement.close(); }
  } finally { await client.close(); f.close(); }
});

test("historical image uncertainty remains visible without disabling the live projection", async () => {
  const f = fixture();
  const feedback: Array<string | null> = [];
  const client = new InlineImages(f.db, { url: "http://127.0.0.1:8791", scopeId: "person" }, () => {}, message => feedback.push(message),
    (async () => Response.json({ ok: true, value: { snapshots: { thread: { version: 1, images: [] } }, errors: ["Historical effects remain unknown; no replay"] } })) as unknown as typeof fetch);
  try {
    expect((await client.start()).ok).toBe(true);
    expect(client.snapshot("thread").version).toBe(1);
    expect(feedback).toContain("Historical effects remain unknown; no replay");
  } finally { await client.close(); f.close(); }
});

test("a rejected image message remains explicit and is never silently dropped", async () => {
  const f = fixture();
  const client = new InlineImages(f.db, { url: "http://127.0.0.1:8791", scopeId: "person" }, () => {}, () => {},
    (async () => Response.json({ ok: false, error: { message: "No data execute/use grant" } }, { status: 403 })) as unknown as typeof fetch);
  try {
    client.accept("thread", "denied", '<pi-remote-image id="denied" prompt="draw" />');
    const result = await client.start();
    expect(result).toMatchObject({ ok: false, error: { code: "rejected" } });
    expect(f.db.query("SELECT state,error FROM core_image_outbox").get()).toEqual({ state: "rejected", error: "No data execute/use grant" });
  } finally { await client.close(); f.close(); }
});
