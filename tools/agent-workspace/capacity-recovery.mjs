import { randomUUID } from "node:crypto";

// The pre-typed deployed receipt is immutable; decode only its exact disk-refusal grammar.
export function capacityRecovery(terminal, previousJobId, observation) {
  if (terminal?.state !== "failed" || !["workspace-capacity-refused", "source-preparation-failed"].includes(terminal.error?.code)) {
    return { state: "terminal" };
  }
  const refusal = /^(\d+\.\d{2}) GiB is free; (\d+\.\d{2}) GiB is required \((?:source forecast \+ declared growth \+ operating headroom \+ other reservations|unestimated full work \+ other reservations)\)$/u.exec(terminal.error.message);
  if (refusal === null) return { state: "terminal" };
  if (!/^[0-9a-f]{64}$/u.test(previousJobId) || !Number.isSafeInteger(observation?.observedAt)
    || typeof observation.device !== "string" || !Number.isSafeInteger(observation.freeBytes)
    || observation.freeBytes < 0 || !Number.isSafeInteger(observation.freeInodes)
    || !Number.isSafeInteger(observation.totalInodes)) {
    return { state: "invalid", error: { code: "capacity-recovery-invalid-observation", message: "capacity recovery requires fresh filesystem evidence and the original job identity" } };
  }
  // Rounding uncertainty is one half display unit. The worker repeats every actual guard under its capacity fence.
  const requiredUpperBytes = Math.ceil((Number(refusal[2]) + 0.005) * 1024 ** 3);
  if (observation.freeBytes < requiredUpperBytes) return { state: "capacity-unavailable", observation };
  return { state: "retry", value: { kind: "capacity-recovery", id: randomUUID(), previousJobId,
    originalRefusal: terminal.error, observation, requiredUpperBytes } };
}
