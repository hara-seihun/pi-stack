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
