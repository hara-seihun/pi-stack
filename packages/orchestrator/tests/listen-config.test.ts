import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, orchestratorUrl } from "../src/config.js";

test("ordinary clients select their own configured daemon and never default to the owner", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-person-endpoint-"));
  const path = join(root, "config.json");
  const env = { HOME: root, PI_ORCHESTRATOR_CONFIG: path };
  try {
    writeFileSync(path, JSON.stringify({ modelBrokerUrl: "http://127.0.0.1:2461" }));
    expect(() => orchestratorUrl(env)).toThrow("own configured port");
    writeFileSync(path, JSON.stringify({ modelBrokerUrl: "http://127.0.0.1:2461", port: 2471, listenHost: "0.0.0.0" }));
    expect(orchestratorUrl(env)).toBe("http://127.0.0.1:2471");
    expect(orchestratorUrl({ ...env, PI_ORCHESTRATOR_PORT: "2472" })).toBe("http://127.0.0.1:2472");
    expect(() => orchestratorUrl({ ...env, PI_ORCHESTRATOR_PORT: "0" })).toThrow("port must be");
    writeFileSync(path, "{}");
    expect(orchestratorUrl(env)).toBe("http://127.0.0.1:2460");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the daemon bind address is independent of worker and local client addresses", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-listen-config-"));
  const path = join(root, "config.json");
  const original = process.env.PI_ORCHESTRATOR_LISTEN_HOST;
  const clientHost = process.env.PI_ORCHESTRATOR_HOST;
  try {
    delete process.env.PI_ORCHESTRATOR_LISTEN_HOST;
    writeFileSync(path, JSON.stringify({ listenHost: "0.0.0.0" }));
    expect(loadConfig(path).listenHost).toBe("0.0.0.0");
    process.env.PI_ORCHESTRATOR_LISTEN_HOST = "127.0.0.2";
    expect(loadConfig(path).listenHost).toBe("127.0.0.2");
    expect(process.env.PI_ORCHESTRATOR_HOST).toBe(clientHost);
    delete process.env.PI_ORCHESTRATOR_LISTEN_HOST;
    writeFileSync(path, "{}");
    expect(loadConfig(path).listenHost).toBeUndefined();
  } finally {
    if (original === undefined) delete process.env.PI_ORCHESTRATOR_LISTEN_HOST;
    else process.env.PI_ORCHESTRATOR_LISTEN_HOST = original;
    rmSync(root, { recursive: true, force: true });
  }
});
