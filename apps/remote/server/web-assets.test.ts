import { expect, test } from "bun:test";
import { join } from "node:path";
import { webResponse } from "./files";

const assets = join(import.meta.dir, "../web/public");
test("the shared router/supervisor asset server serves the meeting avatar for GET and HEAD", async () => {
  const get = webResponse(assets, "/kenan.png", "GET")!;
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe("image/png");
  expect((await get.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  const head = webResponse(assets, "/kenan.png", "HEAD")!;
  expect(head.headers.get("content-type")).toBe("image/png");
  expect(await head.text()).toBe("");
  expect(webResponse(assets, "/kenan.png", "POST")).toBeNull();
  expect(webResponse(assets, "/../package.json", "GET")).toBeNull();
  expect(get.headers.get("content-security-policy")).toMatch(/script-src[^;]*blob:/);
});
