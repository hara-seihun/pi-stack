import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const launcher = fileURLToPath(new URL("./pro", import.meta.url));

test("pro launches Pi on the verified text-only model", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-pro-launcher."));
  try {
    const output = join(directory, "arguments");
    const pi = join(directory, "pi");
    writeFileSync(pi, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >\"$PI_PRO_TEST_OUTPUT\"\n", { mode: 0o700 });
    chmodSync(pi, 0o700);
    const result = spawnSync(launcher, ["--print", "hello"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, PI_PRO_TEST_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(output, "utf8").trim().split("\n"), [
      "--model",
      "chatgpt-pro/gpt-5-6-pro:max",
      "--no-tools",
      "--print",
      "hello",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
