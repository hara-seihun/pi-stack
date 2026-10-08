export function hostWaitKind(wait) {
  switch (wait.kind) {
    case "live-meeting": return "waiting-for-live-meetings";
    case "native-source": return "waiting-for-native-source";
    case "native-history": return "waiting-for-native-history";
    case "host-lock": return "waiting-for-host-deployment-lock";
    case "thread-contract": return "waiting-for-thread-execution-contract";
    default: throw new Error(`Unknown host wait: ${wait.kind}`);
  }
}

// Each host owns its delivery; a wait or failure is not a barrier for its peers.
export function rollForwardHosts(request, targets, operations) {
  request.hosts ??= {};
  for (const target of targets) {
    const previous = request.hosts[target.id];
    if (previous?.status === "passed" || previous?.status === "failed") continue;
    try {
      const outcome = operations.deliver(target, previous);
      if (!["passed", "waiting", "failed"].includes(outcome.status)) throw new Error(`Invalid host outcome for ${target.id}`);
      request.hosts[target.id] = outcome;
    } catch (error) {
      request.hosts[target.id] = { status: "failed", failure: { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) } };
    }
    operations.save(request);
  }
  const failures = targets.filter(target => request.hosts[target.id].status === "failed");
  if (failures.length) return { status: "failed", hosts: failures.map(target => target.id) };
  const waiting = targets.filter(target => request.hosts[target.id].status === "waiting");
  return waiting.length ? { status: "waiting", hosts: waiting.map(target => target.id) } : { status: "passed" };
}
