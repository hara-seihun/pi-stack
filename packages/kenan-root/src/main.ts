import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { rootService, type RootReleaseState } from "./service.js";
import { RootRequestStore } from "./requests.js";
import { createRootExecutor, type RootConfig } from "./root-runtime.js";
import type { ConsultationOwnerResolver } from "./managed-session.js";
import { RootConsentManager, createConsentBridge, rootMemoryRpc } from "./consent.js";

export interface RootIntegrationOptions {
  consultationOwnerFor: ConsultationOwnerResolver;
  drainConsultations(): Promise<void>;
  config: RootConfig;
  privateDir: string;
  memoryRootToken: string;
  adminCapability: string;
  consentCapability: string;
  memoryUrl: string;
  routerUrl: string;
  requestStorePath: string;
  consentStorePath: string;
  enabled(): boolean;
  releaseCommit: string;
  shutdownSignal: AbortSignal;
}
export type RootIntegrationResult = { ok: true; value: ReturnType<typeof rootIntegration> } |
  { ok: false; error: { code: "private-store-unavailable" | "integration-unavailable"; message: string } };

/** A specialized disclosure/outbox integration installed inside the host core. */
export function createRootIntegration(options: RootIntegrationOptions): RootIntegrationResult {
  try {
    const privateDir = resolve(options.privateDir);
    const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
    const decode = (path: string) => path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!mounts.some(line => {
      const [mount, filesystem] = line.split(" - ");
      return decode(mount?.split(" ")[4] ?? "") === privateDir && filesystem?.startsWith("fuse.gocryptfs ");
    })) return { ok: false, error: { code: "private-store-unavailable", message: "Encrypted consultation store is not mounted in the shared core namespace" } };
    for (const path of [options.config.cwd, options.config.agentDir, options.config.sessionsDir, options.requestStorePath, options.consentStorePath]) {
      if (!resolve(path).startsWith(privateDir + sep))
        return { ok: false, error: { code: "private-store-unavailable", message: "Consultation resource is outside its registered private mount" } };
    }
    if (![options.config.cwd, options.config.agentDir, options.config.sessionsDir].every(path => statSync(path).isDirectory()))
      return { ok: false, error: { code: "private-store-unavailable", message: "Consultation resources must be prepared before the core adopts them" } };
    return { ok: true, value: rootIntegration(options) };
  } catch (cause) { return { ok: false, error: { code: "integration-unavailable", message: String(cause) } }; }
}

function rootIntegration(options: RootIntegrationOptions) {
  const requestStore = new RootRequestStore(options.requestStorePath);
  let consent: RootConsentManager;
  try {
    const executor = createRootExecutor(options.config, { consultationOwnerFor: options.consultationOwnerFor,
      consent: (admission, request, input) => consent.request(admission, request, input),
      notify: (admission, toolCallId, input) => consent.notify(admission, toolCallId, input) });
    const bridge = createConsentBridge(options.routerUrl, options.consentCapability);
    consent = new RootConsentManager(options.consentStorePath, {
      bridge, memory: rootMemoryRpc(options.memoryUrl, options.memoryRootToken), executor, enabled: options.enabled });
    const releaseState: RootReleaseState = { dispatchPaused: requestStore.handoffTarget() !== null, consentActive: false };
    const handle = rootService({ enabled: options.enabled, memoryUrl: options.memoryUrl, requestStore, bridge,
      memoryRootToken: options.memoryRootToken, adminCapability: options.adminCapability, sessionsDir: options.config.sessionsDir,
      transcriptPaths: id => {
        const custody = options.consultationOwnerFor(id, "existing");
        if (!custody.ok) throw new Error(custody.message);
        const thread = custody.value.threads.get(id);
        return thread && existsSync(thread.sessionFile) ? [thread.sessionFile] : [];
      },
      executor, releaseCommit: options.releaseCommit, releaseState, shutdownSignal: options.shutdownSignal });
    let reconciliation: Promise<{ errors: number }> | undefined, closed = false;
    const pause = () => { releaseState.dispatchPaused = true; };
    options.shutdownSignal.addEventListener("abort", pause, { once: true });
    return {
      fetch: handle,
      reconcile(): Promise<{ errors: number }> {
        if (reconciliation) return reconciliation;
        if (closed || releaseState.dispatchPaused || options.shutdownSignal.aborted) return Promise.resolve({ errors: 0 });
        releaseState.consentActive = true;
        reconciliation = (async () => {
          try {
            if (!options.enabled()) {
              await handle.dispatchSettled();
              await options.drainConsultations();
              await handle.settled();
              return { errors: 0 };
            }
            const [result, requests] = await Promise.all([consent.drain(() => !releaseState.dispatchPaused && !options.shutdownSignal.aborted), handle.drain()]);
            return { errors: result.errors + requests.errors };
          } finally { releaseState.consentActive = false; reconciliation = undefined; }
        })();
        return reconciliation;
      },
      async drain(): Promise<void> {
        pause(); await reconciliation;
        await handle.dispatchSettled();
        await options.drainConsultations();
        await handle.settled();
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true; pause(); await reconciliation;
        await handle.dispatchSettled(); await options.drainConsultations(); await handle.settled();
        options.shutdownSignal.removeEventListener("abort", pause);
        consent.close(); requestStore.close();
      },
    };
  } catch (cause) { consent!?.close(); requestStore.close(); throw cause; }
}
