import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const syntheticEditor: Plugin = {
  name: "synthetic-editor-handoff",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url) { response.writeHead(400); response.end("Synthetic request URL is missing"); return; }
      const url = new URL(request.url, "http://127.0.0.1:5191");
      if (!url.pathname.startsWith("/v1/")) { next(); return; }
      const imageRoute = url.pathname === "/v1/sessions/22222222-2222-4222-8222-222222222222/files";
      const knownQuery = [...url.searchParams.keys()].every(key => key === "path" || key === "session");
      const knownSession = !url.searchParams.has("session") || ["synthetic-ui-session", "ui-fixture"].includes(url.searchParams.get("session")!);
      if (request.method === "GET" && imageRoute && knownQuery && knownSession) {
        if (url.searchParams.get("path") === "/synthetic/image.png") {
          response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#83c5be"/><circle cx="320" cy="180" r="100" fill="#006d77"/><text x="320" y="190" text-anchor="middle" fill="white" font-size="28">Synthetic image</text></svg>');
          return;
        }
        if (url.searchParams.get("path") === "/synthetic/missing-image.png") { response.writeHead(404); response.end("Synthetic image is unavailable"); return; }
      }
      response.writeHead(501, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "ui_fixture_native_request_unconfigured", message: `No synthetic native request for ${request.method} ${url.pathname}` }));
    });
    server.middlewares.use("/editor/open", (request, response) => {
      if (request.method !== "POST") { response.writeHead(405); response.end("Synthetic editor requires a POST handoff"); return; }
      let body = "";
      request.on("data", chunk => {
        body += String(chunk);
        if (body.length > 4096) { response.writeHead(413); response.end("Synthetic handoff is too large"); request.destroy(); }
      });
      request.on("end", () => {
        if (response.writableEnded) return;
        const form = new URLSearchParams(body);
        const ticket = form.get("ticket");
        const valid = [...form.keys()].length === 1 && (ticket === "s".repeat(43) || ticket === "e".repeat(43));
        if (!valid) { response.writeHead(400); response.end("Unconfigured synthetic handoff ticket"); return; }
        const expired = ticket === "e".repeat(43);
        response.writeHead(expired ? 410 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic editor handoff</title><style>body{font:16px system-ui;background:#0b0d10;color:#f1f4f8;padding:24px;line-height:1.5}button{font:inherit;min-height:44px;padding:8px 16px}</style><h1>${expired ? "Synthetic handoff expired" : "Synthetic handoff accepted"}</h1><p>${expired ? "Return to Files and open the editor again." : "This local fixture validates the browser's POST handoff. It contains no real editor or files."}</p><button onclick="window.close()">Close and return to Files</button></html>`);
      });
      request.on("error", () => { if (!response.writableEnded) { response.writeHead(400); response.end("Synthetic handoff could not be read"); } });
    });
  },
};

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  base: "./",
  esbuild: { jsx: "automatic" },
  plugins: [syntheticEditor],
  server: { host: "127.0.0.1", port: 5191, strictPort: true, hmr: false },
  define: { __PI_REMOTE_REVISION__: JSON.stringify(execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim()) },
});
