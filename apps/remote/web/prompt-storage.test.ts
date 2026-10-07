import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { PromptStorage, type PromptStorageResult, type PromptStorageState } from "./src/prompt-storage";
import { PromptOutbox, type PromptOutboxScope } from "./src/prompt-outbox";
import { PromptSubmissions } from "./src/prompt-submissions";

const scope: PromptOutboxScope = { person: "person-a", environment: "home", bootstrap: "https://router.test/pi/" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const database = new IDBFactory();
  let currentScope = scope;
  let opens = 0;
  let environmentFailure: string | null = null;
  let denyStorage = false;
  const states: PromptStorageState<PromptOutbox>[] = [];
  const storage = new PromptStorage<PromptOutbox>({
    open: async current => {
      opens++;
      if (environmentFailure) throw new Error(environmentFailure);
      const ownerScope = currentScope;
      const store = new PromptOutbox({ scope: ownerScope,
        database: denyStorage ? { open: () => { throw new Error("IndexedDB access denied"); } } as unknown as IDBFactory : database,
        currentScope: () => current() ? currentScope : null });
      const listed = await store.list();
      if (!listed.ok) { store.dispose(); return { ok: false, error: { kind: "unavailable", message: listed.error.message } }; }
      return { ok: true, value: store };
    }, dispose: owner => owner.dispose(), changed: state => states.push(state),
  });
  return { storage, states, opens: () => opens, failEnvironment: (error: string | null) => { environmentFailure = error; },
    denyStorage: (deny: boolean) => { denyStorage = deny; },
    switchScope: (next: PromptOutboxScope) => { currentScope = next; storage.invalidate(); } };
}

for (const cause of ["Environment list returned HTTP 503", "Home health returned HTTP 502", "Native bridge did not supply a bootstrap URL"]) {
  test(`initial ${cause} is visible and Send/Retry can recover without replay or duplicate submission`, async () => {
    const f = fixture();
    f.failEnvironment(cause);
    expect(await f.storage.ensure()).toEqual({ ok: false, error: { kind: "unavailable", message: cause } });
    expect(f.storage.state).toEqual({ kind: "failed", error: { kind: "unavailable", message: cause } });
    f.failEnvironment(null);
    const sending = f.storage.ensure();
    expect(f.storage.ensure()).toBe(sending);
    const recovered = await sending;
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.error.message);
    expect(f.opens()).toBe(2);
    expect(await recovered.value.list()).toEqual({ ok: true, value: [] });
    const input = { requestId: crypto.randomUUID(), text: "  exact draft\nattachment /files/x  ", delivery: "steer" as const };
    expect((await recovered.value.enqueue("original-thread", input)).ok).toBe(true);
    let sends = 0;
    const submissions = new PromptSubmissions();
    const submit = () => submissions.run(recovered.value, input.requestId, async () => recovered.value.submit(input.requestId, async entry => {
      expect(await recovered.value.list()).toMatchObject({ ok: true, value: [{ bodyJson: JSON.stringify(input), sessionId: "original-thread" }] });
      sends++;
      return { status: 202, body: { accepted: true, workId: "accepted", delivery: input.delivery } };
    }));
    await Promise.all([submit(), submit()]);
    expect(sends).toBe(1);
    expect(f.storage.state.kind).toBe("ready");
    f.storage.close();
  });
}

test("failed IndexedDB open recreates the store on retry rather than keeping its failed database promise", async () => {
  const f = fixture();
  f.denyStorage(true);
  expect(await f.storage.ensure()).toMatchObject({ ok: false, error: { message: "IndexedDB access denied" } });
  f.denyStorage(false);
  const result = await f.storage.ensure();
  expect(result.ok).toBe(true);
  expect(f.opens()).toBe(2);
  f.storage.close();
});

test("person, environment and bootstrap changes fence old owners and preserve their durable intent", async () => {
  const f = fixture();
  const original = await f.storage.ensure();
  if (!original.ok) throw new Error(original.error.message);
  const input = { requestId: crypto.randomUUID(), text: "original intent", delivery: "queue" as const };
  await original.value.enqueue("original-thread", input);
  for (const next of [{ ...scope, person: "person-b" }, { ...scope, environment: "cloud" }, { ...scope, bootstrap: "https://router.test/" }]) {
    f.switchScope(next);
    const owner = await f.storage.ensure();
    if (!owner.ok) throw new Error(owner.error.message);
    expect(await owner.value.list()).toEqual({ ok: true, value: [] });
    expect(await original.value.enqueue("original-thread", input)).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
  }
  f.switchScope(scope);
  const reopened = await f.storage.ensure();
  if (!reopened.ok) throw new Error(reopened.error.message);
  expect(await reopened.value.list()).toMatchObject({ ok: true, value: [{ requestId: input.requestId, outcome: { kind: "pending", reason: "saved" } }] });
  f.storage.close();
});

test("auth invalidation during initialization cannot publish a stale owner or overwrite a recovered one", async () => {
  const first = deferred<PromptStorageResult<{ id: string }>>();
  const second = deferred<PromptStorageResult<{ id: string }>>();
  const disposed: string[] = [];
  const states: string[] = [];
  let opens = 0;
  const storage = new PromptStorage({ open: () => ++opens === 1 ? first.promise : second.promise,
    dispose: owner => disposed.push(owner.id), changed: state => states.push(state.kind === "ready" ? state.owner.id : state.kind) });
  const oldSend = storage.ensure();
  await Promise.resolve();
  storage.invalidate();
  const newSend = storage.ensure();
  second.resolve({ ok: true, value: { id: "new-identity" } });
  expect(await newSend).toEqual({ ok: true, value: { id: "new-identity" } });
  first.resolve({ ok: true, value: { id: "old-identity" } });
  expect(await oldSend).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
  expect(disposed).toEqual(["old-identity"]);
  expect(states).not.toContain("old-identity");
  expect(storage.state).toEqual({ kind: "ready", owner: { id: "new-identity" } });
  storage.close();
  expect(disposed).toEqual(["old-identity", "new-identity"]);
  expect(await storage.ensure()).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
});

test("cleanup during bridge discovery disposes a late result, and runtime storage failure permits reopening", async () => {
  const waiting = deferred<PromptStorageResult<{ id: string }>>();
  const disposed: string[] = [];
  const storage = new PromptStorage({ open: () => waiting.promise, dispose: owner => disposed.push(owner.id), changed: () => {} });
  const initializing = storage.ensure();
  await Promise.resolve();
  storage.close();
  waiting.resolve({ ok: true, value: { id: "late" } });
  expect(await initializing).toMatchObject({ ok: false, error: { kind: "scope_changed" } });
  expect(storage.state.kind).toBe("closed");
  expect(disposed).toEqual(["late"]);
  const f = fixture();
  expect((await f.storage.ensure()).ok).toBe(true);
  f.storage.fail("Database connection was closed");
  expect(f.storage.state).toMatchObject({ kind: "failed", error: { message: "Database connection was closed" } });
  expect((await f.storage.ensure()).ok).toBe(true);
  expect(f.opens()).toBe(2);
  f.storage.close();
});
