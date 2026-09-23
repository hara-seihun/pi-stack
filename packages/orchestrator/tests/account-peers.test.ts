import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { fetchAccountFromPeer, resolveFetchPeer, resolvePeerHost } from "../src/auth/account-peers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function config(value: unknown) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-peers-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(value));
  return loadConfig(path);
}

describe("account transfer peers", () => {
  it("loads named peers and still accepts raw SSH aliases for push transfers", () => {
    const peers = config({ peers: { converge: { sshHost: "converge-kenan", returnRoute: { sshHost: "gmktec-pi-account-transfer", port: 22022 } } } }).peers;
    expect(resolvePeerHost(peers, "converge")).toEqual({
      name: "converge",
      sshHost: "converge-kenan",
      returnRoute: { sshHost: "gmktec-pi-account-transfer", port: 22022 },
    });
    expect(resolvePeerHost(peers, "another-host")).toEqual({ sshHost: "another-host" });
    expect(resolveFetchPeer(peers, "converge").returnRoute.port).toBe(22022);
    expect(() => resolveFetchPeer(peers, "another-host")).toThrow("not a configured peer");
  });

  it("rejects malformed return routes while loading config", () => {
    expect(() => config({ peers: { converge: { sshHost: "converge-kenan", returnRoute: { sshHost: "bad host", port: 70000 } } } })).toThrow("returnRoute");
  });

  it("owns the reverse tunnel for exactly the remote transfer process", async () => {
    const peer = resolveFetchPeer(config({ peers: { converge: { sshHost: "converge-kenan", returnRoute: { sshHost: "gmktec-pi-account-transfer", port: 22022 } } } }).peers, "converge");
    const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
    const child = new EventEmitter() as ChildProcess;
    const launch = ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options });
      setImmediate(() => child.emit("close", 0));
      return child;
    }) as Parameters<typeof fetchAccountFromPeer>[4];
    await fetchAccountFromPeer("openai-codex-12", peer, 90_000, AbortSignal.timeout(1_000), launch);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("ssh");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "ControlMaster=no",
      "ControlPath=none",
      "ExitOnForwardFailure=yes",
      "127.0.0.1:22022:127.0.0.1:22",
      "converge-kenan",
    ]));
    expect(calls[0]?.args.at(-1)).toContain("'pi-orchestrator' 'account' 'transfer' 'openai-codex-12' '--to' 'gmktec-pi-account-transfer' '--wait-for-drain' '90000ms'");
    expect(calls[0]?.options).toMatchObject({ stdio: ["ignore", "inherit", "inherit"] });
  });
});
