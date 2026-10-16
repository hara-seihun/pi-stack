import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import { dispatch } from "../src/commands.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function request(daemon: any, path: string, method = "GET", body?: unknown) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { url: path, method, headers: {}, socket: {} });
  let status = 0, output: any;
  await daemon.request(req, { writeHead(code: number) { status = code; }, end(text: string) { output = JSON.parse(text); } });
  return { status, output };
}

async function fixture(broker = false) {
  const root = mkdtempSync(join(tmpdir(), "codex-capabilities-api-")); roots.push(root);
  const authPath = join(root, "auth.json");
  writeFileSync(authPath, JSON.stringify({ account: { type: "oauth", access: "private-access", refresh: "private-refresh", expires: Date.now() + 3_600_000, accountId: "private-account-id" } }));
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "account", provider: "openai-codex" });
  store.upsertAccount({ id: "missing", provider: "openai-codex" });
  const config = { ...loadConfig(join(root, "config.json")), authPath, ...(broker ? { modelBrokerUrl: "http://localhost:2461" } : { modelBrokerUrl: undefined }) };
  const daemon = new Daemon(store, config) as any;
  const close = async () => { await daemon.threads.close(); await daemon.schedules.close(); store.close(); };
  return { daemon, store, close };
}

test("status shows unknown/false/true/error and refresh is a metadata-only owning-daemon operation", async () => {
  const { daemon, close } = await fixture();
  let entitled = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "priority" }, ...(entitled ? [{ id: "ultrafast" }] : [])] }] }));
  try {
    expect((await request(daemon, "/v1/status")).output.codexCapabilities).toMatchObject([{ accountId: "account", status: "unknown", fresh: false, ultrafast: null }, { accountId: "missing", status: "unknown" }]);
    const first = await request(daemon, "/v1/accounts/capabilities", "POST", { accountId: "account" });
    expect(first.status).toBe(200);
    expect(first.output.codexCapabilities).toMatchObject([{ accountId: "account", status: "observed", ultrafast: { "gpt-6-astra": false } }]);
    entitled = true;
    const refreshed = await request(daemon, "/v1/accounts/capabilities", "POST", {});
    expect(refreshed.output.codexCapabilities).toMatchObject([{ accountId: "account", status: "observed", ultrafast: { "gpt-6-astra": true } }, { accountId: "missing", status: "error", error: "credential-unavailable", ultrafast: null }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url, init]) => String(url).includes("/codex/models?") && init?.method === "GET")).toBe(true);
    const status = (await request(daemon, "/v1/status")).output;
    expect(status.codexCapabilities).toEqual(refreshed.output.codexCapabilities);
    expect(JSON.stringify(status)).not.toContain("private-");
    expect((await request(daemon, "/v1/accounts/capabilities", "POST", { accountId: [] })).status).toBe(400);
    expect((await request(daemon, "/v1/accounts/capabilities", "POST", { accountId: "absent" })).status).toBe(404);
  } finally { await close(); }
});

test("a broker-client daemon cannot refresh owner credentials locally", async () => {
  const { daemon, close } = await fixture(true);
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    expect(await request(daemon, "/v1/accounts/capabilities", "POST", {})).toMatchObject({ status: 409, output: { error: expect.stringContaining("account-owning daemon") } });
    expect(fetch).not.toHaveBeenCalled();
  } finally { await close(); }
});

test("CLI capabilities routes all/selected metadata refresh through the daemon and rejects extra args", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ codexCapabilities: [] }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  await dispatch(["account", "capabilities"]);
  await dispatch(["account", "capabilities", "openai-codex-8"]);
  expect(fetch.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method, JSON.parse(String(init?.body))])).toEqual([
    ["/v1/accounts/capabilities", "POST", {}],
    ["/v1/accounts/capabilities", "POST", { accountId: "openai-codex-8" }],
  ]);
  await expect(dispatch(["account", "capabilities", "a", "b"])).rejects.toThrow("usage:");
});
