import { createServer } from "node:http";
import { expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

it("serves worker abort controls and rejects unknown worker actions", async () => {
  const store = Store.open(":memory:");
  const [id] = store.createRuns({ count: 1, source: "direct", prompt: "work", cwd: "/tmp", profile: "standard", budget: "background" });
  const daemon = new Daemon(store, loadConfig("/definitely/missing/config.json"), "/release") as any;
  const server = createServer((req, res) => void daemon.request(req, res));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const abort = await fetch(`${base}/v1/runs/${id}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
    const control = await fetch(`${base}/internal/runs/${id}/control`);
    expect(await control.json()).toEqual({ abort: "abort" });
    const detail = await fetch(`${base}/internal/runs/${id}`);
    expect((await detail.json()).run.id).toBe(id);
    expect((await fetch(`${base}/internal/runs/${id}/unknown`)).status).toBe(404);
    expect((await fetch(`${base}/internal/runs/missing/control`)).status).toBe(404);
    store.setControl('completion:large', JSON.stringify({prompt:'x'.repeat(1_000_000)}));
    store.setControl('run-context:large', JSON.stringify({prompt:'x'.repeat(1_000_000)}));
    store.setControl('fleet-child:large', JSON.stringify({parentRunId:id,task:'x'.repeat(1_000_000)}));
    store.setControl('boost:openai-codex','2');
    store.setControl('account-reservation:openai-codex-12','{"metadata":{"caller":"omniscience"},"reason":"Atlas"}');
    const plansText=await (await fetch(`${base}/v1/plans`)).text();
    expect(plansText.length).toBeLessThan(2000);
    expect(JSON.parse(plansText).controls['boost:openai-codex']).toBe('2');
    expect(JSON.parse(plansText).controls['account-reservation:openai-codex-12']).toBeDefined();
    expect(store.control('completion:large')!.length).toBeGreaterThan(1_000_000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});

it("suspends and restores an account without touching its credential", async () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "openai-codex-3", provider: "openai-codex", concurrency: 4 });
  const daemon = new Daemon(store, loadConfig("/definitely/missing/config.json"), "/release") as any;
  const server = createServer((req, res) => void daemon.request(req, res));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const put = (id: string, body: unknown) =>
      fetch(`${base}/v1/accounts/${id}/enabled`, { method: "PUT", body: JSON.stringify(body) });
    const disabled = await put("openai-codex-3", { enabled: false });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).account.enabled).toBe(false);
    expect(store.account("openai-codex-3")?.enabled).toBe(false);
    const enabled = await put("openai-codex-3", { enabled: true });
    expect((await enabled.json()).account.enabled).toBe(true);
    expect((await put("openai-codex-3", { enabled: "no" })).status).toBe(400);
    expect((await put("missing", { enabled: false })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});

it("retires a disabled account's meter error instead of reporting it forever", async () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "openai-codex-3", provider: "openai-codex", concurrency: 4 });
  store.setControl("meter-error:openai-codex-3", JSON.stringify([{ accountId: "openai-codex-3", outcome: "unmapped-window" }]));
  const daemon = new Daemon(store, loadConfig("/definitely/missing/config.json"), "/release") as any;
  daemon.codexMeters.sample = async () => [];
  daemon.anthropicMeters.sample = async () => [];
  try {
    await daemon.reconcile();
    expect(daemon.status().meterErrors).toEqual([{ accountId: "openai-codex-3", outcome: "unmapped-window" }]);
    store.setAccountEnabled("openai-codex-3", false);
    await daemon.reconcile();
    expect(daemon.status().meterErrors).toEqual([]);
  } finally {
    store.close();
  }
});
