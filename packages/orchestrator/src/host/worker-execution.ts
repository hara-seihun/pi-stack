import { sharedOwner } from "../shared-custody.js";
import type { Run } from "../domain.js";

export function assertWorkerExecution(run: Pick<Run, "execution" | "context">, env = process.env, uid = process.getuid?.()): void {
  if (run.execution === "root-repair") {
    if (uid !== 0) throw new Error("Root-repair worker requires uid 0");
    if (run.context) throw new Error("Root-repair workers require the full normal Pi context");
    if (!sharedOwner(env, uid)) throw new Error("Root-repair worker requires shared filesystem custody");
    for (const key of ["HOME", "PI_CODING_AGENT_DIR", "PI_ORCHESTRATOR_AUTH", "PI_ORCHESTRATOR_LEDGER", "PI_ORCHESTRATOR_CONFIG"]) {
      if (!env[key]?.startsWith("/")) throw new Error(`Root-repair worker requires an explicit absolute ${key}`);
    }
  } else {
    if (run.execution !== undefined && run.execution !== "user") throw new Error(`Unknown worker execution: ${run.execution}`);
    if (uid === 0) throw new Error("Ordinary workers cannot run as uid 0");
  }
}
