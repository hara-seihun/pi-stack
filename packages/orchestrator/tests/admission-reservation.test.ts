import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { CompletionService } from "../src/completion.js";
import { accountCapacity, assign } from "../src/policy.js";
import { allowsAccountUse } from "../src/domain.js";
import { accountReservation, reservationKey, isAccountReservation } from "../src/admission-reservation.js";

const atlas = { metadata: { caller: "omniscience", purpose: "regulatory-atlas-tagging" }, reason: "Atlas highest priority" };
const alias = "openai-codex-12";
const cfg = () => ({ ...loadConfig("/missing/config.json"), taskManifest: undefined, maxConcurrentSessions: 4 });
function account(store: Store) {
  store.upsertAccount({ id: alias, provider: "openai-codex", concurrency: 1 });
  for (const meter of ["codex-5h", "codex-7d"]) store.recordMeter(alias, meter, 82, Date.now() + 86400000, Date.now());
}
function submit(store: Store, id: string, metadata: Record<string, string>) {
  const result = new CompletionService(store, "/tmp").submit(id, { model: "luna", prompt: "classify", metadata });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.runId;
}

it("reserves before import, survives restart, and excludes interactive and unrelated forced admissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reservation-"));
  let store = Store.open(join(dir, "ledger.sqlite3"));
  try {
    store.setControl(reservationKey(alias), JSON.stringify(atlas));
    expect(store.account(alias)).toBeUndefined();
    account(store);
    const matched = submit(store, "atlas", atlas.metadata);
    const other = submit(store, "other", { caller: "omniscience", purpose: "generic-migration" });
    const wrongCaller = submit(store, "wrong-caller", { caller: "other", purpose: "regulatory-atlas-tagging" });
    store.close(); store = Store.open(join(dir, "ledger.sqlite3"));
    expect(allowsAccountUse(store.account(alias)!, "interactive")).toBe(false);
    expect(assign(store, "luna", "force", cfg(), Date.now(), undefined, other).assignment).toBeUndefined();
    expect(assign(store, "astra", "force", cfg()).assignment).toBeUndefined();
    expect(assign(store, "luna", "force", cfg(), Date.now(), undefined, wrongCaller).assignment).toBeUndefined();
    expect(assign(store, "luna", "force", cfg(), Date.now(), undefined, matched).assignment?.accountId).toBe(alias);
    store.recordMeter(alias, "codex-7d", 100, Date.now() + 86400000, Date.now() + 1);
    expect(accountCapacity(store, alias, "force", cfg(), Date.now(), matched).reason).toBe("provider quota exhausted");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("admits the queued Atlas request ahead of older force backlog, retaining reservation between stages", async () => {
  const store = Store.open(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "pi-priority-"));
  const config = { ...cfg(), agentDir: dir };
  const daemon = new Daemon(store, config, "/release") as any;
  daemon.codexMeters.sample = async () => [];
  daemon.anthropicMeters.sample = async () => [];
  daemon.unitIsActive = () => true;
  daemon.unitIsActiveAsync = async () => true;
  const launched: string[] = [];
  daemon.startUnit = () => { throw new Error("Tool-free requests must not spawn agent workers"); };
  daemon.completionPool.start = (run: { id: string }) => launched.push(run.id);
  try {
    account(store);
    store.setControl("launches", "enabled");
    store.setControl(reservationKey(alias), JSON.stringify(atlas));
    const [backlog] = store.createRuns({ count: 1, source: "direct", prompt: "ordinary", cwd: dir, profile: "astra", budget: "force" });
    store.db.prepare("UPDATE run SET created_at=1 WHERE id=?").run(backlog!);
    const generic = submit(store, "generic", { caller: "omniscience", purpose: "generic-migration" });
    const first = submit(store, "sox-existing", atlas.metadata);
    await daemon.reconcile();
    expect(launched).toEqual([first]);
    expect(store.run(backlog!)?.state).toBe("queued");
    expect(store.run(generic)?.state).toBe("queued");
    store.updateRun(first, { state: "done" });
    await daemon.reconcile();
    expect(launched).toEqual([first]);
    const next = submit(store, "atlas-next-stage", atlas.metadata);
    await daemon.reconcile();
    expect(launched).toEqual([first, next]);
    expect(store.control("launches")).toBe("enabled");
    expect(store.run(backlog!)?.budget).toBe("force");
    expect(store.run(first)?.budget).toBe("force");
    expect(store.meters(alias).every(meter => meter.used_percent === 82)).toBe(true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("controls reservations through the daemon API without requiring an imported account", async () => {
  const store = Store.open(":memory:");
  const daemon = new Daemon(store, cfg(), "/release") as any;
  const server = createServer((req, res) => void daemon.request(req, res));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/accounts/${alias}/reservation`;
    expect(isAccountReservation({ metadata: {}, reason: "oops" })).toBe(false);
    expect((await fetch(url, { method: "PUT", body: JSON.stringify({ metadata: {}, reason: "oops" }) })).status).toBe(400);
    expect((await fetch(url, { method: "PUT", body: JSON.stringify(atlas) })).status).toBe(200);
    expect(await (await fetch(url)).json()).toEqual({ reservation: atlas });
    expect(accountReservation(store, alias)).toEqual(atlas);
    account(store);
    expect(allowsAccountUse(store.account(alias)!, "interactive")).toBe(false);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(200);
    expect(allowsAccountUse(store.account(alias)!, "interactive")).toBe(true);
    expect(assign(store, "astra", "force", cfg()).assignment?.accountId).toBe(alias);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});
