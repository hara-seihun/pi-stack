import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../apps/remote/server/server.ts", import.meta.url), "utf8");
const fetchStart = source.indexOf("  async fetch(req, httpServer) {");
const prefixStart = source.indexOf("    const url = new URL(req.url);", fetchStart);
const prefixEnd = source.indexOf("    const peer = httpServer.requestIP(req);", prefixStart);
assert.ok(fetchStart >= 0 && prefixStart > fetchStart && prefixEnd > prefixStart);
const prefix = source.slice(prefixStart, prefixEnd);
const control = new Function("req", "ownsSupervisorLease", "shuttingDown", "supervisorRelease", "API", "json", "error", "VERSION", "ENVIRONMENT_ID", "RELEASE_COMMIT", "API_CORS_HEADERS", prefix + "\nreturn null;");
const invoke = (path = "/v1/health", { method = "GET", owns = true, draining = false } = {}) => control(
  new Request(`http://localhost${path}`, { method }), () => owns, draining,
  { accepts: () => false },
  { health: { match: (method, path) => method === "GET" && path === "/v1/health" } },
  value => Response.json(value), (message, status) => Response.json({ error: message }, { status }),
  "test-version", "test-environment", "tested-commit", {},
);

test("supervisor readiness needs no messaging, thread routing or socket caller discovery", async () => {
  const response = invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: "test-version", environmentId: "test-environment", releaseCommit: "tested-commit", meetingRuntime: { protocol: "meet-runtime-v1", lifetime: "person-service" } });
  assert.equal(invoke("/v1/threads"), null);
  assert.equal(invoke("/v1/health", { method: "POST" }), null);
});

test("readiness still refuses a stale lease or draining supervisor", async () => {
  assert.equal(invoke("/v1/health", { owns: false }).status, 503);
  assert.equal(invoke("/v1/health", { draining: true }).status, 503);
  assert.equal(invoke("/v1/health", { method: "OPTIONS" }).status, 204);
});
