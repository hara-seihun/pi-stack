import { rm } from "node:fs/promises";
import { acquireManagedSessionPolicyLock } from "../../managed-session-policy-lock.js";
import { pruneOwnedManagedSessionRestoreSnapshots, resolveExplicitAutosaveInterval, } from "../../managed-session-restore.js";
import { isManagedSessionRestoreKey } from "../../managed-session-storage.js";
import { isRecord } from "../../parsing.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { runAgentBrowserProcess } from "../../process.js";
import { getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "../../results/envelope.js";
import { redactInvocationArgs } from "../../runtime.js";
const MANAGED_SESSION_DAEMON_INSPECTION_TIMEOUT_MS = 35_000;
const RUNNING_HEADED_AUTOSAVE_POLICY_CHANGE_ERROR = "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS cannot change a running wrapper-owned headed session's launch-time periodic autosave interval. Close that session first, then retry with sessionMode: \"fresh\" so the new daemon starts with the requested interval.";
export function getRunningHeadedAutosavePolicyChangeError(recordedInterval, closeCommand = false) {
    const explicitInterval = resolveExplicitAutosaveInterval(getAgentBrowserProcessEnvironment().AGENT_BROWSER_AUTOSAVE_INTERVAL_MS);
    return recordedInterval !== undefined && !closeCommand && explicitInterval !== undefined && explicitInterval !== recordedInterval
        ? RUNNING_HEADED_AUTOSAVE_POLICY_CHANGE_ERROR
        : undefined;
}
function getHeadedManagedAutosaveEnv(interval) {
    return interval !== undefined ? { AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: interval } : undefined;
}
export async function inspectManagedSessionDaemon(options) {
    const processResult = await runAgentBrowserProcess({
        args: ["--json", "--namespace", options.namespace ?? "", "--session", options.sessionName, "session", "info"],
        cwd: options.cwd,
        env: getHeadedManagedAutosaveEnv(options.headedManagedAutosaveInterval),
        preserveAttachedBrowserSession: options.preserveAttachedBrowserSession,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? MANAGED_SESSION_DAEMON_INSPECTION_TIMEOUT_MS,
    });
    try {
        if (processResult.spawnError?.code === "ENOENT")
            return { status: "missing-binary" };
        if (processResult.aborted || processResult.spawnError || processResult.exitCode !== 0)
            return { status: "unknown" };
        const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
        const data = parsed.parseError || parsed.envelope?.success === false ? undefined : parsed.envelope?.data;
        if (!isRecord(data) || typeof data.active !== "boolean")
            return { status: "unknown" };
        if (!data.active)
            return { status: "inactive" };
        if (!isRecord(data.runtime))
            return { status: "unknown" };
        if (typeof data.runtime.restoreKey === "string" && data.runtime.restoreKey.length > 0)
            return { restoreKey: data.runtime.restoreKey, status: "active" };
        return data.runtime.restoreKey === null ? { restoreKey: null, status: "active" } : { status: "unknown" };
    }
    finally {
        if (processResult.stdoutSpillPath)
            await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
    }
}
export async function acquireOwnedManagedSessionDaemonPolicy(options) {
    const { context, signal } = options;
    if (!context.cwd)
        return { error: "Managed-session policy validation requires the wrapper-owned session cwd." };
    const lock = await acquireManagedSessionPolicyLock({
        namespace: context.namespace,
        sessionName: context.sessionName,
        signal,
    });
    if (!lock) {
        return signal?.aborted
            ? {}
            : {
                error: "Managed-session policy coordination is unavailable or busy. Retry after the current operation finishes, repair the private policy-lock directory, and on POSIX verify that /bin/ps, /usr/bin/ps, or ps through PATH is available.",
            };
    }
    try {
        // Closing is recovery, not reuse: an unresponsive metadata probe must not gate it.
        if (options.mode === "close")
            return { lock };
        const daemon = await inspectManagedSessionDaemon({
            cwd: context.cwd,
            headedManagedAutosaveInterval: context.headedManagedAutosaveInterval,
            namespace: context.namespace,
            sessionName: context.sessionName,
            signal,
        });
        if (daemon.status === "inactive")
            context.restoreState.forgetDaemonRestoreKey(context.sessionName, context.namespace);
        const stickyDisabled = context.restoreState.isDisabled(context.sessionName, context.namespace);
        const hasKnownDaemonRestoreKey = context.restoreState.hasDaemonRestoreKey(context.sessionName, context.namespace);
        const knownDaemonRestoreKey = context.restoreState.getDaemonRestoreKey(context.sessionName, context.namespace);
        const requestedDaemonRestoreKey = context.restoreDecision === "enabled" && stickyDisabled
            ? knownDaemonRestoreKey ?? null
            : context.expectedDaemonRestoreKey;
        if (daemon.status === "unknown") {
            return {
                error: "The wrapper could not verify this managed session's live daemon restore policy. Retry, close that session, or use sessionMode: \"fresh\".",
                lock,
            };
        }
        const restoreDisabledPolicyNeedsProvenance = stickyDisabled || context.restoreDecision !== "enabled";
        const activePolicyMatches = daemon.status === "active"
            && (!restoreDisabledPolicyNeedsProvenance || hasKnownDaemonRestoreKey)
            && daemon.restoreKey === requestedDaemonRestoreKey;
        if (activePolicyMatches)
            context.restoreState.recordDaemonRestoreKey(context.sessionName, context.namespace, daemon.restoreKey);
        return !["inactive", "missing-binary"].includes(daemon.status) && !activePolicyMatches
            ? {
                daemonStatus: daemon.status,
                error: [
                    "This wrapper-owned session's live daemon does not match the requested managed-restore policy.",
                    "Close that session first, retry with sessionMode: \"fresh\", or use a distinct explicit --session.",
                ].join(" "),
                lock,
            }
            : { daemonStatus: daemon.status, lock };
    }
    catch (error) {
        await lock.release();
        throw error;
    }
}
export async function closeManagedSession(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let stdoutSpillPath;
    const closeArgs = [...(options.namespace !== undefined ? ["--namespace", options.namespace] : []), "--session", options.sessionName, "close"];
    const policyLock = options.policyLock ?? await acquireManagedSessionPolicyLock({
        namespace: options.namespace,
        sessionName: options.sessionName,
        signal: controller.signal,
        timeoutMs: Math.min(options.timeoutMs, 1_000),
    });
    if (!policyLock) {
        clearTimeout(timer);
        return "Managed-session policy coordination is unavailable or busy; cleanup did not run. Retry after the current operation finishes or repair the private policy-lock directory.";
    }
    try {
        const daemonRestoreKey = options.restoreState.getDaemonRestoreKey(options.sessionName, options.namespace);
        const ownedRestoreKey = !options.restoreState.isDisabled(options.sessionName, options.namespace)
            && isManagedSessionRestoreKey(daemonRestoreKey) ? daemonRestoreKey : null;
        const processResult = await runAgentBrowserProcess({
            args: closeArgs,
            cwd: options.cwd,
            env: { AGENT_BROWSER_JSON: "1", ...getHeadedManagedAutosaveEnv(options.headedManagedAutosaveInterval) },
            managedSessionRestoreState: options.restoreState,
            ownedManagedSession: true,
            preserveAttachedBrowserSession: options.preserveAttachedBrowserSession,
            signal: controller.signal,
        });
        stdoutSpillPath = processResult.stdoutSpillPath;
        const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
        const data = parsed.envelope?.success === true && isRecord(parsed.envelope.data) ? parsed.envelope.data : undefined;
        if (!processResult.aborted && !processResult.spawnError && processResult.exitCode === 0 && data?.closed === true) {
            options.restoreState.clear(options.sessionName, options.namespace);
            pruneOwnedManagedSessionRestoreSnapshots({
                cwd: options.cwd,
                namespace: options.namespace,
                restoreKey: ownedRestoreKey,
                statePath: typeof data?.statePath === "string" ? data.statePath : undefined,
            });
        }
        return getAgentBrowserErrorText({
            aborted: processResult.aborted,
            command: "close",
            effectiveArgs: redactInvocationArgs(closeArgs),
            envelope: parsed.envelope,
            parseError: parsed.parseError,
            exitCode: processResult.exitCode,
            plainTextInspection: false,
            spawnError: processResult.spawnError,
            stderr: processResult.stderr,
            timedOut: processResult.timedOut,
            timeoutMs: processResult.timeoutMs,
        }) ?? (data?.closed === true ? undefined : "Native close did not confirm closed:true; the session remains wrapper-owned.");
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    finally {
        clearTimeout(timer);
        if (stdoutSpillPath)
            await rm(stdoutSpillPath, { force: true }).catch(() => undefined);
        if (!options.policyLock)
            await policyLock.release();
    }
}
