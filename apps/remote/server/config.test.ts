import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function load(environment: Record<string, unknown>, inherited?: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-environment-"));
  const config = join(root, "person.json");
  const env = { ...process.env };
  delete env.NX_NATIVE_FILE_CACHE_DIRECTORY;
  if (inherited !== undefined) env.NX_NATIVE_FILE_CACHE_DIRECTORY = inherited;
  try {
    writeFileSync(config, JSON.stringify({ version: 1, environment }));
    return Bun.spawnSync([process.execPath, "--eval", `
      import { applyLocalConfig } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
      applyLocalConfig(${JSON.stringify(config)});
      const child = Bun.spawnSync([process.execPath, "--eval", "console.log(process.env.NX_NATIVE_FILE_CACHE_DIRECTORY)"], {
        env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 2000,
      });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      process.stdout.write(child.stdout);
    `], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("person configuration gives new runtime children their host cache binding", () => {
  const result = load({ NX_NATIVE_FILE_CACHE_DIRECTORY: "/host/nx-native" });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString().trim()).toBe("/host/nx-native");
});

test("explicit process environment still takes precedence over person defaults", () => {
  const result = load({ NX_NATIVE_FILE_CACHE_DIRECTORY: "/host/nx-native" }, "/explicit/nx-native");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("/explicit/nx-native");
});

test("invalid environment names fail before starting a runtime child", () => {
  const result = load({ "invalid-name": "/host/nx-native" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Invalid environment key");
  expect(result.stdout.toString()).toBe("");
});

test("message sender identity comes from the owning person registry", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-person-identity-"));
  try {
    const config = join(root, "person.json");
    writeFileSync(config, JSON.stringify({ version: 1, user: "hara", displayName: "Hara", environment: {} }));
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { applyLocalConfig } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
      applyLocalConfig(${JSON.stringify(config)});
      console.log(JSON.stringify({ id: process.env.PI_REMOTE_SENDER_ID, name: process.env.PI_REMOTE_SENDER_NAME }));
    `], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 2_000 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ id: "hara", name: "Hara" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
