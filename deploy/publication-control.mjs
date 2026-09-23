import { existsSync, statSync } from "node:fs";

export const policy = Object.freeze({
  commandGraceMs: 15_000,
  idleMs: 120_000,
  betweenStepsMs: 90_000,
  blockedRetryMs: 30_000,
  blockedLimitMs: 300_000,
  maxAttempts: 3,
  maxRepairDepth: 2,
  maxLaunchAttempts: 3,
  repairMs: 1_200_000,
});

export function stallReason(request, now = Date.now()) {
  if (request.status !== "running") return null;
  const progress = request.progress;
  if (!progress) {
    return now - Date.parse(request.updatedAt) > policy.betweenStepsMs ? "Worker stopped recording progress" : null;
  }
  if (now > Date.parse(progress.deadlineAt) + policy.commandGraceMs) return `Command exceeded deadline ${progress.deadlineAt}`;
  if (progress.log && existsSync(progress.log)) {
    const latest = Math.max(Date.parse(progress.startedAt), statSync(progress.log).mtimeMs);
    if (now - latest > policy.idleMs) return `No command or log progress for ${policy.idleMs / 1000}s`;
  }
  return null;
}

export function runnable(request, now = Date.now()) {
  return request.status === "queued" && now >= Date.parse(request.nextAttemptAt ?? request.updatedAt ?? 0);
}

export function repairId(requestId) { return `REPAIR-${requestId}`; }
export function repairUnit(requestId) { return `pi-stack-publication-repair@${requestId}.service`; }

export function repairPrompt(request, repair, command) {
  return `You own a bounded repair of Pi Stack publication ${request.requestId}. Hara authorizes repairing the cause and returning the release to its publication owner. This dedicated local agent runs independently of the paused general fleet.

Source SHA: ${request.sourceSha}
Integration SHA: ${request.integrationSha ?? "not created"}
Failed step: ${request.failure?.step ?? request.step}
Failure: ${request.failure?.message ?? request.waiting?.reason}
Failure reason: ${request.failure?.reason ?? request.waiting?.reason}
Exact command and progress: ${JSON.stringify(request.failure?.progress ?? request.progress ?? null)}
Full publication log: ${request.failure?.log ?? request.waiting?.log}
Receipt: ${repair.requestPath}
Repair receipt: ${repair.path}
Your saved session: ${repair.session}
Your workspace: ${repair.workspace ?? "not prepared"}
Workspace preparation: ${repair.workspaceError ?? "ready"}
Compact log context:
${request.failure?.excerpt ?? "See the full log."}

Please repair the owning code or host configuration, keeping existing source refs, receipts and host restoration plans. Run focused checks that take seconds. Full publication checks remain the worker's responsibility; skipping checks or resubmitting an unchanged defect is not a repair. Work in the registered checkout and commit source changes there. If workspace preparation failed, please repair that tooling or source-custody problem first and use agent-workspace to obtain a writer checkout. Return its absolute path in a workspace field when different from the path above. The wrapper will submit the corrected commit once and record its causal link. Do not publish or retry from this agent, and do not change publication request or repair receipts yourself.

Write ${repair.result} with one JSON result when you finish:
- {"status":"source-fixed","sourceSha":"40-character commit","summary":"cause and repair","evidence":"absolute path to a focused check or diagnosis receipt"}
- {"status":"infrastructure-fixed","summary":"cause and actual host repair","evidence":"absolute path to a focused proof receipt"} if the original source now deserves its one repaired retry.
- {"status":"blocked","summary":"what remains and exactly what Hara needs to supply"} if this attempt cannot repair it.

You have one ${policy.repairMs / 60_000}-minute turn, not a retry loop. Retain useful changes and report an honest blocker if the repair cannot finish. The publication command is ${command}. The wrapper retains terminal reporting and links any corrected submission back to this failed request.
`;
}
