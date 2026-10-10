import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { editorResponse, editorHeaders, editorFrameHeaders } from "./editor-proxy";
import type { Person } from "./persons";

const person: Person = { version: 1, user: "alice", displayName: "Alice", port: 19000, environment: {}, unlock: { cipherDir: "/home/alice/.crypt", mountpoint: "/home/alice/private" }, editor: { workspace: "/home/alice/private", origin: "http://alice-editor.example" } };

test("editor Unix HTTP preserves encoded bytes without app credentials or cache reuse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-editor-test-"));
  const socket = join(dir, "http.sock");
  let received: Headers | null = null;
  const body = gzipSync("editor-file-content");
  const server = Bun.serve({ unix: socket, fetch(req) {
    received = req.headers;
    return new Response(body, { headers: { "content-encoding": "gzip", "content-type": "text/plain", "set-cookie": "unowned=1", "cache-control": "public,max-age=99999", "x-frame-options": "SAMEORIGIN", "content-security-policy": "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-eval'" } });
  } });
  try {
    const url = new URL("http://alice-editor.example/asset.js");
    const req = new Request(url, { headers: { "x-pi-remote-session": "private", "x-pi-remote-upstream": "private", authorization: "private", cookie: "private", "cf-access-token": "private", "x-forwarded-host": "unowned", origin: person.editor!.origin } });
    const response = await editorResponse(person, req, url, new AbortController().signal, socket, "http://pi.example");
    expect(response.status).toBe(200);
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe("editor-file-content");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; script-src 'self' 'unsafe-eval'; frame-ancestors 'self' http://pi.example");
    expect(received!.get("host")).toBe("alice-editor.example");
    for (const name of ["x-pi-remote-session", "x-pi-remote-upstream", "authorization", "cookie", "cf-access-token", "x-forwarded-host"]) expect(received!.get(name)).toBeNull();
    expect(editorHeaders(new Request(url), person).get("host")).toBe("alice-editor.example");
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("every upstream CSP policy retains its other directives but only the authorized parent can frame", () => {
  const headers = new Headers({
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; FRAME-ANCESTORS *; report-uri /report, script-src 'nonce-test'; frame-ancestors 'none'",
    "content-security-policy-report-only": "img-src data:; frame-ancestors https://unowned.test",
  });
  editorFrameHeaders(headers, "https://pi.example.net:8443");
  expect(headers.get("content-security-policy")).toBe("default-src 'self'; report-uri /report; frame-ancestors 'self' https://pi.example.net:8443, script-src 'nonce-test'; frame-ancestors 'self' https://pi.example.net:8443");
  expect(headers.get("content-security-policy-report-only")).toBe("img-src data:; frame-ancestors 'self' https://pi.example.net:8443");
  expect(headers.get("x-frame-options")).toBeNull();
  const absent = new Headers();
  editorFrameHeaders(absent, "http://pi.mesh.test");
  expect(absent.get("content-security-policy")).toBe("frame-ancestors 'self' http://pi.mesh.test");
  expect(absent.has("content-security-policy-report-only")).toBe(false);
  expect(() => editorFrameHeaders(new Headers(), "https://pi.example.net/path")).toThrow();
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
