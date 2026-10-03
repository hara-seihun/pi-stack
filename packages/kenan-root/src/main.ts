import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { oneKenanEnabled } from "kenan-memory/config";
import { KENAN_ROOT_DEFAULT_PORT } from "kenan-memory/contract";
import { rootService } from "./service.js";
import { createRootExecutor, readRootConfig } from "./root-runtime.js";
import { awaitPrivateMount } from "kenan-memory/private-store";

if (!oneKenanEnabled()) throw new Error("Root Kenan is disabled by the host flag");
const closing = new AbortController();
process.on("SIGTERM", () => closing.abort());
process.on("SIGINT", () => closing.abort());
const privateDir = process.env.PI_KENAN_PRIVATE_DIR ?? "/var/lib/pi-kenan/private";
if (!await awaitPrivateMount(privateDir, closing.signal)) process.exit(0);
const config = readRootConfig();
if (process.env.PI_MODEL_BROKER_URL) config.brokerUrl = process.env.PI_MODEL_BROKER_URL;
const credential = (env: string, name: string) => readFileSync(process.env[env] ?? join(process.env.CREDENTIALS_DIRECTORY ?? "/run/credentials/pi-kenan-root.service", name), "utf8").trim();
const memoryRootToken = credential("PI_KENAN_MEMORY_ROOT_TOKEN_FILE", "kenan-memory-root");
const adminCapability = credential("PI_KENAN_ROOT_ADMIN_CAPABILITY_FILE", "kenan-root-admin");
for (const path of [config.cwd, config.agentDir, config.sessionsDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
const handle = rootService({ enabled: oneKenanEnabled, memoryUrl: process.env.PI_KENAN_MEMORY_URL ?? "http://127.0.0.1:18820",
  memoryRootToken, adminCapability, sessionsDir: config.sessionsDir, executor: createRootExecutor(config) });
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PI_KENAN_ROOT_PORT ?? KENAN_ROOT_DEFAULT_PORT), idleTimeout: 255,
  fetch: handle });
closing.signal.addEventListener("abort", () => { server.stop(true); process.exit(0); }, { once: true });
console.log(`Root Kenan ready on loopback:${server.port}`);
