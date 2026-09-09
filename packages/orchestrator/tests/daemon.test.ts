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
