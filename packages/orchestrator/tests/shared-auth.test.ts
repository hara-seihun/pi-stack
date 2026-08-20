import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedCodexAuth, codexCredential } from "../src/auth/shared-codex.js";

const dirs: string[] = [];

function fixture(expires: number) {
  const dir = mkdtempSync(join(tmpdir(), "shared-codex-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires,
      accountId: "account-1",
    },
  }), { mode: 0o660 });
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared Codex auth", () => {
  it("serves a valid credential without refreshing it", async () => {
    const path = fixture(1_000_000);
    let refreshes = 0;
    const auth = new SharedCodexAuth({
      path,
      now: () => 1000,
      refresh: async (credential) => { refreshes++; return credential; },
      toAuth: async (credential) => ({ apiKey: credential.access }),
    });
    expect(await auth.resolve("openai-codex", new AbortController().signal)).toEqual({ apiKey: "access-1" });
    expect(refreshes).toBe(0);
  });

  it("refreshes under the central lock and preserves group-readable mode", async () => {
    const path = fixture(1000);
    const auth = new SharedCodexAuth({
      path,
      now: () => 10_000,
      refresh: async () => ({
        type: "oauth",
        access: "access-2",
        refresh: "refresh-2",
        expires: 100_000,
        accountId: "account-1",
      }),
      toAuth: async (credential) => ({ apiKey: credential.access }),
    });
    expect((await auth.credential("openai-codex", new AbortController().signal)).access).toBe("access-2");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(codexCredential(persisted["openai-codex"])?.refresh).toBe("refresh-2");
    expect(statSync(path).mode & 0o777).toBe(0o660);
  });

  it("refuses to store the same account identity under two aliases", async () => {
    const path = fixture(1_000_000);
    const auth = new SharedCodexAuth({
      path,
      refresh: async (credential) => credential,
      toAuth: async (credential) => ({ apiKey: credential.access }),
    });
    await expect(auth.set("openai-codex-2", {
      type: "oauth",
      access: "other",
      refresh: "other",
      expires: 20_000,
      accountId: "account-1",
    })).rejects.toThrow(/already stored/);
  });
});
