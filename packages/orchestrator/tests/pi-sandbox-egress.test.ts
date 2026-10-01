import { afterEach, describe, expect, it, vi } from "vitest";
import { Resolver } from "node:dns/promises";
import { connect } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPublicSandboxAddress, parseSandboxProxyTarget, resolveSandboxAddress, startSandboxEgress } from "../src/threads/pi-sandbox-egress.js";

afterEach(() => vi.restoreAllMocks());

describe("sandbox public-download egress", () => {
  it("benchmark exposes only the gateway without resolving denied hosts or opening CONNECT", async () => {
    const root = await mkdtemp(join(tmpdir(), "benchmark-proxy-"));
    const socketPath = join(root, "gateway.sock");
    const gateway = createServer((req, res) => { res.end(JSON.stringify({ path: req.url, method: req.method, asOf: "2024-01-01" })); });
    await new Promise<void>(resolve => gateway.listen(socketPath, resolve));
    const dns = vi.spyOn(Resolver.prototype, "resolve4");
    const started = await startSandboxEgress({ profile: "benchmark", gatewaySocket: socketPath });
    if (!started.ok) throw new Error(started.error.message);
    const call = (method: string, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: started.value.socketPath, method, path, agent: false }, res => {
        let body = "";
        res.on("data", chunk => body += chunk.toString());
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.end();
    });
    try {
      expect(await call("POST", "http://research.gateway/search")).toEqual({ status: 200, body: JSON.stringify({ path: "/search", method: "POST", asOf: "2024-01-01" }) });
      for (const host of ["example.com", "api.parallel.ai", "api.exa.ai", "dns.google", "127.0.0.1", "research.gateway.evil", "research.gateway:80"])
        expect((await call("GET", `http://${host}/`)).status, host).toBe(403);
      const connectResponse = await new Promise<string>((resolve, reject) => {
        const s = connect(started.value.socketPath, () => s.end("CONNECT research.gateway:443 HTTP/1.1\r\nHost: research.gateway:443\r\n\r\n"));
        let response = "";
        s.on("data", chunk => response += chunk.toString()); s.on("end", () => resolve(response)); s.on("error", reject);
      });
      expect(connectResponse).toContain("403 Forbidden");
      expect(dns).not.toHaveBeenCalled();
    } finally {
      await started.value.close();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  it("excludes private, metadata, translated, reserved and host addresses", () => {
    for (const address of [
      "0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
      "100.100.100.200", "100.64.0.1", "168.63.129.16", "198.18.1.1", "203.0.113.1", "224.0.0.1",
      "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "64:ff9b::a00:1",
      "2002:0a00:0001::1", "2001:db8::1", "3fff::1", "garbage",
    ]) expect(isPublicSandboxAddress(address), address).toBe(false);
    expect(isPublicSandboxAddress("8.8.8.8")).toBe(true);
    expect(isPublicSandboxAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicSandboxAddress("8.8.8.8", ["8.8.8.8"])).toBe(false);
    expect(isPublicSandboxAddress("2606:4700:4700::1111", ["2606:4700:4700:0:0:0:0:1111"])).toBe(false);
  });

  it("requires unambiguous HTTP URLs and narrow CONNECT authority syntax", () => {
    for (const raw of [
      "https://example.com/", "http://user:pass@example.com/", "http://example.com@127.0.0.1/",
      "http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/", "http://example.com:080/",
      "http://example.com:443/", "http://example.com./", "http://example.com/#fragment",
      "http://example.com\\@127.0.0.1/", "http://%31%32%37.0.0.1/", "http://example.com/\u0000",
    ]) expect(parseSandboxProxyTarget("GET", raw).ok, raw).toBe(false);
    for (const raw of ["example.com", "example.com:22", "example.com:8443", "example.com:00443", "user@example.com:443", "[::1%lo]:443"])
      expect(parseSandboxProxyTarget("CONNECT", raw).ok, raw).toBe(false);
    expect(parseSandboxProxyTarget("GET", "http://registry.npmjs.org/package?version=1")).toEqual({
      ok: true, value: { hostname: "registry.npmjs.org", port: 80, path: "/package?version=1", authority: "registry.npmjs.org" },
    });
    expect(parseSandboxProxyTarget("CONNECT", "[2606:4700::1111]:443").ok).toBe(true);
  });

  it("rejects a mixed public/private DNS answer and returns the validated pinned address", async () => {
    vi.spyOn(Resolver.prototype, "resolve4").mockResolvedValue(["8.8.8.8"]);
    const ipv6 = vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue(["::1"]);
    expect(await resolveSandboxAddress("example.com")).toMatchObject({ ok: false, error: { code: "egress-denied" } });
    ipv6.mockResolvedValue(["2606:4700:4700::1111"]);
    expect(await resolveSandboxAddress("example.com")).toEqual({ ok: true, value: { address: "8.8.8.8", family: 4 } });
  });

  it("owns a private unix socket, emits useful denials, and removes the socket on close", async () => {
    const started = await startSandboxEgress();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const egress = started.value;
    const exchange = (request: string) => new Promise<string>((resolve, reject) => {
      const socket = connect(egress.socketPath, () => socket.end(request));
      let response = "";
      socket.setTimeout(2_000, () => socket.destroy(new Error("Proxy test timeout")));
      socket.on("data", chunk => { response += chunk.toString(); });
      socket.on("error", reject);
      socket.on("end", () => resolve(response));
    });
    try {
      expect((await stat(egress.socketPath)).mode & 0o777).toBe(0o600);
      expect(await exchange("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n")).toContain("403 Forbidden");
      expect(await exchange("GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n")).toContain("Target resolves to a non-public or host address");
      expect(await exchange("CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n")).toContain("403 Forbidden");
    } finally {
      await egress.close();
    }
    await expect(stat(egress.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await egress.close();
  });
});
