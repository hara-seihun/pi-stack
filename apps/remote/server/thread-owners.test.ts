import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredOrchestratorThreadUrl, orchestratorThreadUrl } from "./thread-owners";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("each Unix person selects only their authorized Orchestrator", () => {
  expect(orchestratorThreadUrl({ fleetUser: "kenan" }, "sybil", "http://127.0.0.1:2461", "http://127.0.0.1:2460"))
    .toBe("http://127.0.0.1:2461");
  expect(orchestratorThreadUrl({ fleetUser: "kenan" }, "sybil", undefined, "http://127.0.0.1:2460")).toBeNull();
  expect(orchestratorThreadUrl({ fleetUser: "kenan" }, "kenan")).toBe("http://127.0.0.1:2460");
  expect(orchestratorThreadUrl({ fleetUser: "kenan" }, "kenan", undefined, "http://127.0.0.1:2469")).toBe("http://127.0.0.1:2469");
});

test("ordinary Remote discovers the daemon port from that person's config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-thread-owner-"));
  cleanup.push(root);
  const home = join(root, "sybil");
  const configDir = join(home, ".config/pi-orchestrator");
  const hostPath = join(root, "host.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 2461 }));
  writeFileSync(hostPath, JSON.stringify({ fleetUser: "kenan" }));

  const env = { HOME: home, PI_STACK_HOST_CONFIG: hostPath, PI_REMOTE_ORCHESTRATOR_URL: "http://127.0.0.1:2460" };
  expect(configuredOrchestratorThreadUrl(env, "sybil")).toBe("http://127.0.0.1:2461");

  rmSync(join(configDir, "config.json"));
  expect(configuredOrchestratorThreadUrl(env, "sybil")).toBeNull();

  writeFileSync(join(configDir, "config.json"), JSON.stringify({ modelBrokerUrl: "http://127.0.0.1:3451" }));
  expect(() => configuredOrchestratorThreadUrl(env, "sybil")).toThrow("needs its own configured port");
});
