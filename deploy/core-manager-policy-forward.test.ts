import { expect, test } from "bun:test";
import { forwardManagerPolicy } from "./core-manager-policy-forward";
const token = "a".repeat(64);
const request = (path = "/v1/canonical-manager-policy", body = "{}", method = "POST") => new Request(`http://127.0.0.1:18788${path}`, { method, headers: { "x-pi-canonical-manager-policy": token, authorization: "discard", cookie: "discard", "x-pi-remote-user": "another" }, ...(method === "POST" ? { body } : {}) });
test("SSH endpoint forwards only exact bounded policy reads and strips unrelated authority", async () => {
  let seen: unknown;
  const result = await forwardManagerPolicy(request(), async (url, init) => { seen = { url, headers: init?.headers, body: new TextDecoder().decode(init?.body as Uint8Array), redirect: init?.redirect }; return Response.json({ ok: false, error: { code: "forbidden" } }, { status: 403, headers: { "set-cookie": "discard" } }); });
  expect(result.status).toBe(403);expect(result.headers.get("set-cookie")).toBeNull();
  expect(seen).toEqual({ url: "http://127.0.0.1:8788/v1/canonical-manager-policy", headers: { "content-type": "application/json", "x-pi-canonical-manager-policy": token }, body: "{}", redirect: "error" });
});
test("general router routes, queries, verbs, large metadata and transport failures remain refused", async () => {
  let calls = 0; const transport = async () => { calls++; return Response.json({}); };
  for (const req of [request("/v1/files"), request("/v1/canonical-manager-policy?query=yes"), request(undefined, undefined, "GET"), request(undefined, "x".repeat(4097)), new Request("http://127.0.0.1:18788/v1/canonical-manager-policy", { method: "POST", body: "{}" })]) expect((await forwardManagerPolicy(req, transport)).status).not.toBe(200);
  expect(calls).toBe(0);
  expect((await forwardManagerPolicy(request(), async () => { throw new Error("closed"); })).status).toBe(503);
  expect((await forwardManagerPolicy(request(), async () => new Response("x".repeat(4097)))).status).toBe(503);
});

test("notice transport carries bounded original outcomes without opening generic send", async () => {
  const body = JSON.stringify({ input: { text: "x".repeat(8000) } });
  let seen: unknown;
  const result = await forwardManagerPolicy(request("/v1/canonical-manager-notice", body), async (url, init) => {
    seen = { url, body: new TextDecoder().decode(init?.body as Uint8Array), headers: init?.headers };
    return Response.json({ ok: true, value: { id: "original" } });
  });
  expect(result.status).toBe(200);
  expect(seen).toEqual({ url: "http://127.0.0.1:8788/v1/canonical-manager-notice", body, headers: { "content-type": "application/json", "x-pi-canonical-manager-policy": token } });
  expect((await forwardManagerPolicy(request("/v1/manager-relay/send"), async () => { throw new Error("must not forward"); })).status).toBe(403);
});

import { MANAGER_CONTEXT_PATH, MANAGER_CONTEXT_BYTES } from "../apps/remote/server/canonical-manager-context";
test("reciprocal forward admits only the enrolled context path and strips all unrelated caller authority", async () => {
  let calls = 0;
  const result = await forwardManagerPolicy(request(MANAGER_CONTEXT_PATH, JSON.stringify({ operation: "managerQuestionCustody", input: { requestId: "custody-ask:original" } })), async (url, init) => {
    calls++; expect(url).toBe(`http://127.0.0.1:8788${MANAGER_CONTEXT_PATH}`);
    expect(init?.headers).toEqual({ "content-type": "application/json", "x-pi-canonical-manager-policy": token });
    return Response.json({ ok: true, value: { accepted: true } });
  });
  expect(result.status).toBe(200); expect(calls).toBe(1);
  for (const path of ["/v1/manager-relay/managerQuestionCustody", `${MANAGER_CONTEXT_PATH}/send`, `${MANAGER_CONTEXT_PATH}?account=another`])
    expect((await forwardManagerPolicy(request(path), async () => { calls++; return Response.json({}); })).status).toBe(403);
  expect((await forwardManagerPolicy(request(MANAGER_CONTEXT_PATH, "x".repeat(MANAGER_CONTEXT_BYTES + 1)), async () => { calls++; return Response.json({}); })).status).toBe(503);
  expect(calls).toBe(1);
});
