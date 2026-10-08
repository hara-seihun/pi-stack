#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Source: fitchmultz/pi-agent-browser-native v0.6.6, fe59ce7e5e4b2f4ba3312a1d4ac3b42fa5fe2cb9.
// Pinned managed-close recovery and typed daemon-busy inspection; no wrapper/API version upgrade.
export const managedCloseTarget = "dist/extensions/agent-browser/lib/orchestration/browser-run/managed-session-daemon-policy.js";
const originalSha256 = "4c797d1b5e4ce35b5778f52bebc899cea8f5d2542930ab368ed252ba1d61084c";
const previousSha256 = "934de44e03f16bb59e155320dcb0a9ad69319eec39e7efaf1a8920525b963c4b";
const patchedSha256 = "9eefcb80cfa89d4f9a7f7aa58da2d0cdca6219fd8875c2d1ee983cb4af895e81";
const closeChanges = [
  [
    `    try {
        const daemon = await inspectManagedSessionDaemon({
            cwd: context.cwd,`,
    `    try {
        // Closing is recovery, not reuse: an unresponsive metadata probe must not gate it.
        if (options.mode === "close")
            return { lock };
        const daemon = await inspectManagedSessionDaemon({
            cwd: context.cwd,`,
  ],
  [
    `        if (options.mode === "close") {
            if (daemon.status === "active")
                context.restoreState.recordDaemonRestoreKey(context.sessionName, context.namespace, daemon.restoreKey);
            return { daemonStatus: daemon.status, lock };
        }
`,
    "",
  ],
  [
    `        const daemon = await inspectManagedSessionDaemon({
            cwd: options.cwd,
            headedManagedAutosaveInterval: options.headedManagedAutosaveInterval,
            namespace: options.namespace,
            preserveAttachedBrowserSession: options.preserveAttachedBrowserSession,
            sessionName: options.sessionName,
            signal: controller.signal,
            timeoutMs: Math.min(options.timeoutMs, 2_000),
        });
        if (daemon.status === "active")
            options.restoreState.recordDaemonRestoreKey(options.sessionName, options.namespace, daemon.restoreKey);
`,
    "",
  ],
  [
    `        if (!processResult.aborted && !processResult.spawnError && processResult.exitCode === 0) {
            const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
            const data = parsed.envelope?.success === true && isRecord(parsed.envelope.data) ? parsed.envelope.data : undefined;`,
    `        const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
        const data = parsed.envelope?.success === true && isRecord(parsed.envelope.data) ? parsed.envelope.data : undefined;
        if (!processResult.aborted && !processResult.spawnError && processResult.exitCode === 0 && data?.closed === true) {`,
  ],
  [
    `            effectiveArgs: redactInvocationArgs(closeArgs),
            exitCode: processResult.exitCode,`,
    `            effectiveArgs: redactInvocationArgs(closeArgs),
            envelope: parsed.envelope,
            parseError: parsed.parseError,
            exitCode: processResult.exitCode,`,
  ],
  [
    `            timeoutMs: processResult.timeoutMs,
        });
    }
    catch (error) {`,
    `            timeoutMs: processResult.timeoutMs,
        }) ?? (data?.closed === true ? undefined : "Native close did not confirm closed:true; the session remains wrapper-owned.");
    }
    catch (error) {`,
  ],
];

const inspectionChanges = [
  [
    `import { rm } from "node:fs/promises";`,
    `import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";`,
  ],
  [
    `export async function inspectManagedSessionDaemon(options) {`,
    `export async function inspectManagedSessionDaemon(options) {
    const busyDeadline = performance.now() + 1_000;
    let attemptOptions = options;
    while (true) {
        if (options.signal?.aborted)
            return { status: "unknown" };
        const daemon = await inspectManagedSessionDaemonOnce(attemptOptions);
        if (options.signal?.aborted)
            return { status: "unknown" };
        if (daemon.status !== "busy")
            return daemon;
        const waitMs = Math.min(50, busyDeadline - performance.now());
        if (waitMs <= 0)
            return daemon;
        try {
            await delay(waitMs, undefined, { signal: options.signal });
        } catch (error) {
            if (options.signal?.aborted)
                return { status: "unknown" };
            throw error;
        }
        const remainingMs = busyDeadline - performance.now();
        if (remainingMs <= 0)
            return daemon;
        attemptOptions = { ...options, timeoutMs: Math.min(options.timeoutMs ?? MANAGED_SESSION_DAEMON_INSPECTION_TIMEOUT_MS, Math.max(1, Math.ceil(remainingMs))) };
    }
}
async function inspectManagedSessionDaemonOnce(options) {`,
  ],
  [
    `        if (processResult.aborted || processResult.spawnError || processResult.exitCode !== 0)
            return { status: "unknown" };
        const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
        const data = parsed.parseError || parsed.envelope?.success === false ? undefined : parsed.envelope?.data;`,
    `        if (processResult.aborted || processResult.spawnError || processResult.timedOut || options.signal?.aborted)
            return { status: "unknown" };
        const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
        if (!parsed.parseError && parsed.envelope?.success === false && parsed.envelope.code === "daemon_busy")
            return { status: "busy" };
        if (processResult.exitCode !== 0)
            return { status: "unknown" };
        const data = parsed.parseError || parsed.envelope?.success !== true ? undefined : parsed.envelope.data;`,
  ],
  [
    `        if (daemon.status === "unknown") {`,
    `        if (daemon.status === "busy") {
            return {
                daemonStatus: "busy",
                error: "The managed session daemon is busy: a command or browser maintenance still owns its state. Policy inspection exhausted its bounded retry; no command was dispatched. Retry after the current operation settles.",
                lock,
            };
        }
        if (daemon.status === "unknown") {`,
  ],
];

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function patchBrowserManagedClose(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.name !== "pi-agent-browser-native" || manifest.version !== "0.6.6") {
    throw new Error("Unsupported native browser wrapper for managed-close repair");
  }
  const target = join(root, managedCloseTarget);
  const original = readFileSync(target, "utf8");
  const originalDigest = digest(original);
  if (originalDigest === patchedSha256) return;
  if (![originalSha256, previousSha256].includes(originalDigest)) throw new Error("Native managed-close source differs from pinned v0.6.6");
  let patched = original;
  const changes = originalDigest === originalSha256 ? [...closeChanges, ...inspectionChanges] : inspectionChanges;
  for (const [before, after] of changes) {
    if (patched.split(before).length !== 2) throw new Error("Native managed-close source anchor changed");
    patched = patched.replace(before, after);
  }
  if (digest(patched) !== patchedSha256) throw new Error("Native managed-close patch output differs from compiled source");
  writeFileSync(target, patched);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("usage: patch-browser-managed-close.mjs NATIVE_PACKAGE_ROOT");
  patchBrowserManagedClose(process.argv[2]);
}
