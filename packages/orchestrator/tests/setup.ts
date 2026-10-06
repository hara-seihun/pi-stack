import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "orchestrator-test-home-"));
process.env.HOME = home;
// /missing only suppresses the config file; ledger symlinks and inherited
// runtime settings otherwise still lead admission tests to the host's OAuth.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_ORCHESTRATOR_") || [
    "PI_MODEL_BROKER_URL", "PI_CODEX_ULTRAFAST_BROKER_URL",
    "PI_AGENT_DIR", "PI_CODING_AGENT_DIR",
  ].includes(key)) delete process.env[key];
}

afterAll(() => rmSync(home, { recursive: true, force: true }));
