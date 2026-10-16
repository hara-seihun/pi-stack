import { afterEach, expect, test, vi } from "vitest";
import { CompletionClient } from "../src/completion-client.js";
vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }));
afterEach(() => vi.unstubAllEnvs());

test("explicit UID-bound broker wins over tokenless gateway origin and receives no unrelated bearer", async () => {
  vi.stubEnv("PI_MODEL_BROKER_URL", "http://127.0.0.1:19100");
  vi.stubEnv("PI_CORE_URL", "http://127.0.0.1:19300");
  vi.stubEnv("PI_CORE_TOKEN_FILE", "/must-not-read-this-unrelated-token");
  const transport = vi.fn(async () => Response.json({ error: { code: "not-found", message: "No record" } }, { status: 404 }));
  const client = new CompletionClient({ fetch: transport });
  expect(await client.get("stable-id")).toMatchObject({ ok: false, error: { code: "not-found" } });
  expect(transport).toHaveBeenCalledWith("http://127.0.0.1:19100/v1/completions/stable-id", expect.objectContaining({ headers: { "content-type": "application/json" } }));
});

test("core-only inference refuses tokenless requests before sending bytes", async () => {
  vi.stubEnv("PI_MODEL_BROKER_URL", undefined);
  vi.stubEnv("PI_CORE_URL", "http://127.0.0.1:19300");
  vi.stubEnv("PI_CORE_TOKEN_FILE", undefined);
  const transport = vi.fn();
  expect(await new CompletionClient({ fetch: transport }).get("stable-id")).toMatchObject({ ok: false, error: { code: "authentication" } });
  expect(transport).not.toHaveBeenCalled();
});
