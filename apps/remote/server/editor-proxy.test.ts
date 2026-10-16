import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { editorResponse, editorHeaders } from "./editor-proxy";
import type { Person } from "./persons";

const person: Person = { version: 1, user: "alice", displayName: "Alice", port: 19000, environment: {}, unlock: { cipherDir: "/home/alice/.crypt", mountpoint: "/home/alice/private" }, editor: { workspace: "/home/alice/private", origin: "http://alice-editor.example" } };

test("editor Unix HTTP preserves encoded bytes without app credentials or cache reuse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-editor-test-"));
  const socket = join(dir, "http.sock");
  let received: Headers | null = null;
  const body = gzipSync("editor-file-content");
  const server = Bun.serve({ unix: socket, fetch(req) {
    received = req.headers;
    return new Response(body, { headers: { "content-encoding": "gzip", "content-type": "text/plain", "set-cookie": "unowned=1", "cache-control": "public,max-age=99999" } });
  } });
  try {
    const url = new URL("http://alice-editor.example/asset.js");
    const req = new Request(url, { headers: { "x-pi-remote-session": "private", "x-pi-remote-upstream": "private", authorization: "private", cookie: "private", "cf-access-token": "private", "x-forwarded-host": "unowned", origin: person.editor!.origin } });
    const response = await editorResponse(person, req, url, new AbortController().signal, socket);
    expect(response.status).toBe(200);
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe("editor-file-content");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(received!.get("host")).toBe("alice-editor.example");
    for (const name of ["x-pi-remote-session", "x-pi-remote-upstream", "authorization", "cookie", "cf-access-token", "x-forwarded-host"]) expect(received!.get(name)).toBeNull();
    expect(editorHeaders(new Request(url), person).get("host")).toBe("alice-editor.example");
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("installed Bun carries binary editor frames over a private Unix WebSocket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-editor-ws-test-"));
  const socket = join(dir, "http.sock");
  const server = Bun.serve({ unix: socket, fetch(req, server) { return server.upgrade(req) ? undefined : new Response(null, { status: 400 }); }, websocket: { message(socket, body) { socket.send(body); } } });
  const client = new WebSocket(`ws+unix://${socket}:/stream`);
  client.binaryType = "arraybuffer";
  try {
    const frame = await new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Unix WebSocket timeout")), 1000);
      client.addEventListener("open", () => client.send(new Uint8Array([0, 255, 17])), { once: true });
      client.addEventListener("message", event => { clearTimeout(timer); resolve(event.data as ArrayBuffer); }, { once: true });
      client.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Unix WebSocket failed")); }, { once: true });
    });
    expect([...new Uint8Array(frame)]).toEqual([0, 255, 17]);
  } finally { client.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
