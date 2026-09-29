import { afterEach, describe, expect, it, vi } from "vitest";
import { Resolver } from "node:dns/promises";
import { connect } from "node:net";
import { stat } from "node:fs/promises";
import { isPublicSandboxAddress, parseSandboxProxyTarget, resolveSandboxAddress, startSandboxEgress } from "../src/threads/pi-sandbox-egress.js";

afterEach(() => vi.restoreAllMocks());

describe("sandbox public-download egress", () => {
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
