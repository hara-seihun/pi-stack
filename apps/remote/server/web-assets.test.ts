import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressDirectory } from "../compress-dist.mjs";
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

/** A miniature `web/dist`: a page, a hashed bundle, and a file too small to be worth compressing. */
function builtSite() {
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-web-assets-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>Pi Remote</title>${"<p>page</p>".repeat(300)}`);
  writeFileSync(join(dir, "assets/index-abc123.js"), `export const app = ${JSON.stringify("x".repeat(4000))};\n`);
  writeFileSync(join(dir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  compressDirectory(dir);
  return dir;
}

const request = (headers: Record<string, string>) => new Request("https://router.test/", { headers });

test("built text assets are served precompressed when the client accepts it", async () => {
  const dir = builtSite();
  try {
    const identity = webResponse(dir, "/assets/index-abc123.js", "GET")!;
    const raw = await identity.arrayBuffer();
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("vary")).toBe("accept-encoding");

    const brotli = webResponse(dir, "/assets/index-abc123.js", "GET", request({ "accept-encoding": "gzip, deflate, br, zstd" }))!;
    expect(brotli.headers.get("content-encoding")).toBe("br");
    expect(brotli.headers.get("content-type")).toMatch(/javascript/);
    expect(brotliDecompressSync(Buffer.from(await brotli.arrayBuffer()))).toEqual(Buffer.from(raw));
    expect(Number(brotli.headers.get("content-length"))).toBeLessThan(raw.byteLength);

    const gzip = webResponse(dir, "/assets/index-abc123.js", "GET", request({ "accept-encoding": "gzip, deflate" }))!;
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gzip.arrayBuffer()))).toEqual(Buffer.from(raw));

    const refused = webResponse(dir, "/assets/index-abc123.js", "GET", request({ "accept-encoding": "br;q=0, gzip;q=0" }))!;
    expect(refused.headers.get("content-encoding")).toBeNull();
    expect((await refused.arrayBuffer()).byteLength).toBe(raw.byteLength);

    // Twins are an implementation detail of the server, not a route.
    expect(webResponse(dir, "/assets/index-abc123.js.br", "GET")).toBeNull();
    expect(webResponse(dir, "/assets/index-abc123.js.gz", "GET")).toBeNull();
    // Small files stay single.
    expect(webResponse(dir, "/icon.svg", "GET", request({ "accept-encoding": "br" }))!.headers.get("content-encoding")).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hashed bundles are immutable and pages revalidate with an ETag", async () => {
  const dir = builtSite();
  try {
    const bundle = webResponse(dir, "/assets/index-abc123.js", "GET")!;
    expect(bundle.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(bundle.headers.get("etag")).toBeNull();

    const page = webResponse(dir, "/index.html", "GET")!;
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-security-policy")).toMatch(/script-src[^;]*blob:/);
    const etag = page.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const revalidated = webResponse(dir, "/index.html", "GET", request({ "if-none-match": etag }))!;
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("cache-control")).toBe("no-cache");
    expect(await revalidated.text()).toBe("");

    // A compressed representation carries its own validator, so a cached identity
    // copy is not revalidated against brotli bytes.
    const compressed = webResponse(dir, "/index.html", "GET", request({ "accept-encoding": "br" }))!;
    expect(compressed.headers.get("content-encoding")).toBe("br");
    expect(compressed.headers.get("etag")).toBe(`${etag.slice(0, -1)}-br"`);
    expect(webResponse(dir, "/index.html", "GET", request({ "accept-encoding": "br", "if-none-match": etag }))!.status).toBe(200);
    const matched = webResponse(dir, "/index.html", "GET", request({ "accept-encoding": "br", "if-none-match": compressed.headers.get("etag")! }))!;
    expect(matched.status).toBe(304);
    expect(matched.headers.get("content-encoding")).toBe("br");

    expect(webResponse(dir, "/", "GET")!.headers.get("etag")).toBe(etag);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compression is deterministic and drops twins whose file is gone", () => {
  const dir = builtSite();
  const read = (name: string) => readFileSync(join(dir, name));
  try {
    const before = { br: read("index.html.br"), gz: read("index.html.gz") };
    const again = compressDirectory(dir);
    expect(again.written).toContain(join(dir, "index.html.gz"));
    expect({ br: read("index.html.br"), gz: read("index.html.gz") }).toEqual(before);

    rmSync(join(dir, "index.html"));
    compressDirectory(dir);
    expect(existsSync(join(dir, "index.html.br"))).toBe(false);
    expect(existsSync(join(dir, "index.html.gz"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
