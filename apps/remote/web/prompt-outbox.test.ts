import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { PROMPT_OUTBOX_LIMITS, PromptOutbox, type OutboxResult, type PromptOutboxBody, type PromptOutboxScope } from "./src/prompt-outbox";

function value<T>(result: OutboxResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const scope: PromptOutboxScope = { person: "person-a", environment: "local", bootstrap: "https://router.example/pi-stack/" };
const body = (delivery: PromptOutboxBody["delivery"] = "steer"): PromptOutboxBody => ({ requestId: crypto.randomUUID(), text: "Hello\n\nThe following files were attached to this message:\n- /files/exact.png", delivery, replyTo: "pi/thread/original" });
function fixture() {
  const database = new IDBFactory();
  let current: PromptOutboxScope | null = scope;
  const create = (owner = scope) => new PromptOutbox({ scope: owner, database, currentScope: () => current });
  return { database, create, switch: (next: PromptOutboxScope | null) => { current = next; } };
}
const accepted = (delivery: PromptOutboxBody["delivery"]) => ({ status: 202, body: { accepted: true, workId: "durable-admission", delivery } });

test("intent precedes HTTP and exact request, attachment text, reply and delivery survive lost ack and reload", async () => {
  for (const delivery of ["queue", "steer", "hardSteer"] as const) {
    const f = fixture();
    const first = f.create();
    const input = body(delivery);
    const saved = value(await first.enqueue("thread", input));
    const transmitted: string[] = [];
    const lost = value(await first.submit(input.requestId, async entry => {
      expect(value(await f.create().list())[0]?.bodyJson).toBe(JSON.stringify(input));
      transmitted.push(entry.bodyJson);
      throw new Error("Server admitted it; response lost");
    }));
    expect(lost.outcome).toMatchObject({ kind: "pending", reason: "transport" });
    first.dispose();
    const reloaded = f.create();
    expect(value(await reloaded.list())[0]?.requestId).toBe(input.requestId);
    expect(transmitted).toHaveLength(1);
    const final = value(await reloaded.submit(input.requestId, async entry => {
      transmitted.push(entry.bodyJson);
      return accepted(delivery);
    }));
    expect(transmitted).toEqual([saved.bodyJson, saved.bodyJson]);
    expect(final.outcome).toEqual({ kind: "accepted", workId: "durable-admission" });
    expect(value(await f.create().list())[0]?.outcome.kind).toBe("accepted");
    await reloaded.submit(input.requestId, async () => { throw new Error("Must not replay accepted prompt"); });
    expect((await reloaded.acknowledge(input.requestId)).ok).toBe(true);
    expect(value(await reloaded.list())).toEqual([]);
  }
});

test("only authoritative rejection is terminal; unavailable, malformed, generic400 and auth retain intent", async () => {
  const f = fixture();
  const outbox = f.create();
  const responses = [
    { status: 400, body: { error: "An old server lost the acknowledgement" } },
    { status: 503, body: { outcome: "pending", error: "Thread owner unavailable" } },
    { status: 202, body: { accepted: true, workId: "wrong-mode", delivery: "queue" } },
    { status: 200, body: { ok: true } },
    { status: 423, body: { error: "Locked" } },
  ];
  const input = body();
  value(await outbox.enqueue("thread", input));
  for (const response of responses) expect(value(await outbox.submit(input.requestId, async () => response)).outcome.kind).toBe("pending");
  expect(await outbox.acknowledge(input.requestId)).toMatchObject({ ok: false, error: { kind: "pending_not_acknowledged" } });
  const rejected = value(await outbox.submit(input.requestId, async () => ({ status: 403, body: { outcome: "rejected", error: "Use the room API" } })));
  expect(rejected.outcome).toEqual({ kind: "rejected", message: "Use the room API" });
  expect(value(await f.create().list())[0]?.outcome).toEqual(rejected.outcome);
  let calls = 0;
  await outbox.submit(input.requestId, async () => { calls++; return accepted("steer"); });
  expect(calls).toBe(0);
});

test("person, environment and bootstrap mount fences isolate saved prompts and prevent stale transport", async () => {
  const f = fixture();
  const original = f.create();
  const input = body();
  value(await original.enqueue("thread", input));
  for (const other of [{ ...scope, person: "person-b" }, { ...scope, environment: "remote" }, { ...scope, bootstrap: "https://router.example/" }]) {
    f.switch(other);
    expect(value(await f.create(other).list())).toEqual([]);
    expect(await original.list()).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
    let calls = 0;
    expect(await original.submit(input.requestId, async () => { calls++; return accepted("steer"); })).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
    expect(calls).toBe(0);
  }
  f.switch(null);
  expect(await original.list()).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
  f.switch(scope);
  expect(value(await f.create().list())[0]?.requestId).toBe(input.requestId);
});

test("owner disposal aborts a pending transport and never acknowledges it into another owner", async () => {
  const f = fixture();
  const outbox = f.create();
  const input = body();
  value(await outbox.enqueue("thread", input));
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let signal!: AbortSignal;
  const operation = outbox.submit(input.requestId, async (_entry, aborted) => {
    signal = aborted; start();
    return new Promise(() => {});
  });
  await started;
  outbox.dispose();
  expect(await operation).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
  expect(signal.aborted).toBe(true);
  expect(value(await f.create().list())[0]?.outcome.kind).toBe("pending");
});

test("concurrent storage writers enforce count bound without evicting any unconfirmed intent", async () => {
  const f = fixture();
  const writers = [f.create(), f.create()];
  const results = await Promise.all(Array.from({ length: PROMPT_OUTBOX_LIMITS.entries + 2 }, (_, i) => writers[i % 2]!.enqueue("thread", body())));
  expect(results.filter(result => result.ok)).toHaveLength(PROMPT_OUTBOX_LIMITS.entries);
  expect(results.filter(result => !result.ok)).toEqual([
    { ok: false, error: { kind: "full", message: expect.any(String) } },
    { ok: false, error: { kind: "full", message: expect.any(String) } },
  ]);
  expect(value(await writers[0]!.list())).toHaveLength(PROMPT_OUTBOX_LIMITS.entries);
});

test("byte bound returns full before a request can be transmitted", async () => {
  const f = fixture();
  const outbox = f.create();
  const input = { ...body(), text: "🙂".repeat(PROMPT_OUTBOX_LIMITS.bytes / 4) };
  expect(await outbox.enqueue("thread", input)).toMatchObject({ ok: false, error: { kind: "full" } });
  expect(value(await outbox.list())).toEqual([]);
});

test("saved request identity cannot change its body or recipient; caller mutation cannot change saved JSON", async () => {
  const f = fixture();
  const outbox = f.create();
  const input = { ...body() };
  const serialized = JSON.stringify(input);
  const saving = outbox.enqueue("thread", input);
  const requestId = input.requestId;
  input.requestId = crypto.randomUUID(); input.text = "changed";
  expect(value(await saving).bodyJson).toBe(serialized);
  const original = JSON.parse(serialized);
  expect(await outbox.enqueue("other-thread", original)).toMatchObject({ ok: false, error: { kind: "conflicting_request" } });
  expect(await outbox.enqueue("thread", { ...original, delivery: "queue" })).toMatchObject({ ok: false, error: { kind: "conflicting_request" } });
  expect(value(await outbox.list())[0]?.requestId).toBe(requestId);
});

test("commands, Stop, unknown prompt fields and missing delivery cannot enter replay storage", async () => {
  const outbox = fixture().create();
  for (const invalid of [{ requestId: crypto.randomUUID(), action: "stop", descendants: true }, { ...body(), name: "compact" }, { ...body(), delivery: undefined }, { ...body(), control: "stop" }]) {
    expect(await outbox.enqueue("thread", invalid as PromptOutboxBody)).toMatchObject({ ok: false, error: { kind: "invalid_prompt" } });
  }
  expect(value(await outbox.list())).toEqual([]);
});

test("unavailable storage returns a typed error; no volatile success", async () => {
  const outbox = new PromptOutbox({ scope, currentScope: () => scope, database: { open: () => { throw new Error("Storage disabled"); } } as unknown as IDBFactory });
  expect(await outbox.enqueue("thread", body())).toEqual({ ok: false, error: { kind: "storage_unavailable", message: "Storage disabled" } });
});

test("corrupt saved records return an explicit error without sending or silently evicting intent", async () => {
  const f = fixture();
  const outbox = f.create();
  const input = body();
  value(await outbox.enqueue("thread", input));
  const opened = f.database.open("pi-remote-prompt-outbox", 1);
  const db = await new Promise<IDBDatabase>((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("prompts", "readwrite");
    const store = transaction.objectStore("prompts");
    const entries = store.getAll();
    entries.onsuccess = () => { store.put({ ...entries.result[0], bodyJson: JSON.stringify({ ...input, delivery: "stop" }) }); };
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  });
  expect(await outbox.list()).toMatchObject({ ok: false, error: { kind: "storage_corrupt" } });
  let calls = 0;
  expect(await outbox.submit(input.requestId, async () => { calls++; return accepted("steer"); })).toMatchObject({ ok: false, error: { kind: "storage_corrupt" } });
  expect(calls).toBe(0);
  db.close();
});

test("simultaneous submit shares one request; explicit discard never replays work", async () => {
  const outbox = fixture().create();
  const input = body();
  value(await outbox.enqueue("thread", input));
  let calls = 0;
  const transport = async () => { calls++; return accepted("steer"); };
  await Promise.all([outbox.submit(input.requestId, transport), outbox.submit(input.requestId, transport)]);
  expect(calls).toBe(1);
  const pending = body();
  value(await outbox.enqueue("thread", pending));
  expect((await outbox.discard(pending.requestId)).ok).toBe(true);
  expect(await outbox.submit(pending.requestId, transport)).toMatchObject({ ok: false, error: { kind: "not_found" } });
  expect(calls).toBe(1);
});
