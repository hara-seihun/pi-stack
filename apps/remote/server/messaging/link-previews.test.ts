import { expect, test } from "bun:test";
import { createLinkPreviewResolver, PreviewOverloaded } from "./link-previews";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test("fetches OG text and a relative raster image through pinned HTTP; caches the result", async () => {
  let htmlHits = 0;
  let imageHits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/images/card.png") { imageHits++; return new Response(png, { headers: { "content-type": "image/png" } }); }
    htmlHits++;
    const html = `<meta property="og:title" content="The &amp; Title"><meta property="og:description" content="An overview"><meta property="og:site_name" content="Example"><meta property="og:image" content="/images/card.png">` + " ".repeat(600_000);
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  try {
    const resolve = createLinkPreviewResolver(async () => "127.0.0.1");
    const url = `http://preview.example:${server.port}/article`;
    const first = await resolve(url);
    expect(first).toEqual({ url, title: "The & Title", description: "An overview", siteName: "Example", imageUrl: `data:image/png;base64,${png.toString("base64")}` });
    expect(await resolve(url)).toEqual(first);
    expect(htmlHits).toBe(1);
    expect(imageHits).toBe(1);
  } finally { server.stop(true); }
});

test("queues preview work at four active requests and reports overflow for retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    hits++;
    await gate;
    return new Response('<title>Queued card</title>', { headers: { "content-type": "text/html" } });
  } });
  try {
    const resolve = createLinkPreviewResolver(async () => "127.0.0.1");
    const urls = Array.from({ length: 12 }, (_, i) => `http://preview.example:${server.port}/${i}`);
    const tasks = urls.map(url => resolve(url));
    expect(resolve(`http://preview.example:${server.port}/overflow`)).rejects.toBeInstanceOf(PreviewOverloaded);
    release();
    expect((await Promise.all(tasks)).map(card => card.title)).toEqual(Array(12).fill("Queued card"));
    expect(hits).toBe(12);
  } finally { release(); server.stop(true); }
});
