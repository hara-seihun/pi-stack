import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { oneKenanEnabled } from "kenan-memory/config";
import { KENAN_ROOT_DEFAULT_PORT } from "kenan-memory/contract";
import { rootService, type RootReleaseState } from "./service.js";
import { RootRequestStore } from "./requests.js";
import { createRootExecutor, readRootConfig } from "./root-runtime.js";
import { recoverRootOwners } from "./managed-session.js";
import { awaitPrivateMount } from "kenan-memory/private-store";
import { RootConsentManager, createConsentBridge, rootMemoryRpc } from "./consent.js";

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
const consentCapability = credential("PI_KENAN_ROOT_CONSENT_TOKEN_FILE", "kenan-root-consent");
for (const path of [config.cwd, config.agentDir, config.sessionsDir]) {
  if (!resolve(path).startsWith(resolve(privateDir) + sep)) throw new Error("Root execution must remain inside the mounted encrypted private store");
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
await recoverRootOwners(config);
const memoryUrl = process.env.PI_KENAN_MEMORY_URL ?? "http://127.0.0.1:18820";
let consent: RootConsentManager;
const executor = createRootExecutor(config, { consent: (admission, request, input) => consent.request(admission, request, input),
  notify: (admission, toolCallId, input) => consent.notify(admission, toolCallId, input) });
const consentStore = resolve(process.env.PI_KENAN_ROOT_CONSENT_STORE ?? join(privateDir, "root/consent.sqlite3"));
if (!consentStore.startsWith(resolve(privateDir) + sep)) throw new Error("Root consent must remain inside the mounted encrypted private store");
const bridge = createConsentBridge(process.env.PI_KENAN_ROOT_ROUTER_URL ?? "http://127.0.0.1:8788", consentCapability);
consent = new RootConsentManager(consentStore, {
  bridge,
  memory: rootMemoryRpc(memoryUrl, memoryRootToken), executor, enabled: oneKenanEnabled });
const releaseState: RootReleaseState = { quiescing: false, consentActive: false };
const timer = setInterval(async () => {
  if (releaseState.consentActive || releaseState.quiescing || closing.signal.aborted) return;
  releaseState.consentActive = true;
  try {
    const [result, requests] = await Promise.all([consent.drain(), handle.drain()]);
    if (result.errors) console.error(`Root consent: ${result.errors} pending exchanges require retry; state retained`);
    if (requests.errors) console.error(`Root requests: ${requests.errors} pending replies require retry; state retained`);
  }
  finally { releaseState.consentActive = false; }
}, 2_000);
const requestStorePath = resolve(process.env.PI_KENAN_ROOT_REQUEST_STORE ?? join(privateDir, "root/requests.sqlite3"));
if (!requestStorePath.startsWith(resolve(privateDir) + sep)) throw new Error("Root requests must remain inside the mounted encrypted private store");
const requestStore = new RootRequestStore(requestStorePath);
const handle = rootService({ enabled: oneKenanEnabled, memoryUrl, requestStore, bridge,
  memoryRootToken, adminCapability, sessionsDir: config.sessionsDir, executor,
  releaseCommit: process.env.PI_STACK_RELEASE_COMMIT, releaseState });
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PI_KENAN_ROOT_PORT ?? KENAN_ROOT_DEFAULT_PORT), idleTimeout: 255,
  fetch: handle });
closing.signal.addEventListener("abort", () => { clearInterval(timer); server.stop(true); process.exit(0); }, { once: true });
console.log(`Root Kenan ready on loopback:${server.port}`);
