import { describe, expect, it } from "bun:test";
import { proxyFetch } from "./proxy-fetch";

describe("proxyFetch", () => {
  it("preserves gzip bytes with their content-encoding header", async () => {
    const payload = JSON.stringify({ transcript: "large client response".repeat(200) });
    const compressed = Bun.gzipSync(Buffer.from(payload));
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(compressed, {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      }),
    });

    try {
      const response = await proxyFetch(`http://127.0.0.1:${upstream.port}/`, {
        headers: { "accept-encoding": "gzip" },
      });
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(body.equals(Buffer.from(compressed))).toBe(true);
      expect(Buffer.from(Bun.gunzipSync(body)).toString()).toBe(payload);
    } finally {
      upstream.stop(true);
    }
  });
});
