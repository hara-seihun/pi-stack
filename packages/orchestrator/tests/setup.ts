import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "orchestrator-test-home-"));
process.env.HOME = home;
// /missing only suppresses the config file; ledger symlinks and inherited
// runtime settings otherwise still lead admission tests to the host's OAuth.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_ORCHESTRATOR_") || key.startsWith("PI_AGENT_CAPACITY_") || [
    "PI_MODEL_BROKER_URL", "PI_CODEX_ULTRAFAST_BROKER_URL",
    "PI_AGENT_DIR", "PI_CODING_AGENT_DIR",
  ].includes(key)) delete process.env[key];
}

process.env.PI_AGENT_CAPACITY_CONFIG = join(home, "agent-capacity-client.json");
// Daemon admission reads the household model policy; never the host's.
process.env.PI_STACK_MODEL_AVAILABILITY_PATH = join(home, "model-availability.json");

afterAll(() => rmSync(home, { recursive: true, force: true }));
