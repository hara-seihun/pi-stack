import { execFile } from "node:child_process";
import type { Ledger } from "../ledger/ledger.js";
import { evalGate, parseGate } from "./gate.js";
import type {
  EvaluateResult,
  ProbeRunner,
  SchedulerConfig,
  TaskSnapshot,
} from "./types.js";

export const defaultSchedulerConfig: SchedulerConfig = {
  demandTtlMs: 60_000,
  gateDebounceMs: 0,
  probeTimeoutMs: 30_000,
};

/** Runs a probe command; the last stdout line must be a non-negative number. */
export function execProbeRunner(timeoutMs: number): ProbeRunner {
  return (command) =>
    new Promise((resolve, reject) => {
      execFile("bash", ["-c", command], { timeout: timeoutMs }, (error, stdout) => {
        if (error) return reject(new Error(`probe failed: ${error.message}`));
        const last = stdout.trim().split("\n").at(-1) ?? "";
        const units = Number(last);
        if (!Number.isFinite(units) || units < 0) {
          return reject(new Error(`probe output not a non-negative number: "${last}"`));
        }
        resolve(units);
      });
    });
}

/**
 * The eligibility reactor. Each evaluation refreshes stale or invalidated
 * demand probes, evaluates gates against current demand, applies debounce,
 * and reports which tasks are eligible for launch. It launches nothing
 * itself; allocation over admitted capacity is a separate pure step.
 */
export class Scheduler {
  private readonly cfg: SchedulerConfig;
  private readonly runProbe: ProbeRunner;

  constructor(
    private readonly ledger: Ledger,
    cfg: Partial<SchedulerConfig> = {},
    runProbe?: ProbeRunner,
  ) {
    this.cfg = { ...defaultSchedulerConfig, ...cfg };
    this.runProbe = runProbe ?? execProbeRunner(this.cfg.probeTimeoutMs);
  }

  async evaluate(now = Date.now()): Promise<EvaluateResult> {
    if ((this.ledger.getControl("launches") ?? "enabled") !== "enabled") {
      return { launches: "paused", tasks: [] };
    }
    const tasks = this.ledger.tasks();

    await Promise.all(
      tasks.map(async (t) => {
        if (t.demandCommand === undefined) return;
        const st = this.ledger.demandState(t.id);
        const fresh =
          st !== undefined &&
          !st.invalidated &&
          st.probedAt !== undefined &&
          now - st.probedAt < this.cfg.demandTtlMs;
        if (fresh) return;
        try {
          const units = await this.runProbe(t.demandCommand);
          this.ledger.recordDemand(t.id, { units }, now);
        } catch (thrown) {
          this.ledger.recordDemand(t.id, { error: String(thrown) }, now);
        }
      }),
    );

    const unitsOf = new Map<string, number | undefined>();
    const errorOf = new Map<string, string | undefined>();
    for (const t of tasks) {
      if (t.demandConstant !== undefined) {
        unitsOf.set(t.id, t.demandConstant);
        errorOf.set(t.id, undefined);
      } else {
        const st = this.ledger.demandState(t.id);
        unitsOf.set(t.id, st?.error === undefined ? st?.units : undefined);
        errorOf.set(t.id, st?.error);
      }
    }

    const snapshots: TaskSnapshot[] = tasks.map((t) => {
      const units = unitsOf.get(t.id);
      const rawOpen =
        t.gate === undefined
          ? true
          : (evalGate(parseGate(t.gate), (id) => unitsOf.get(id)) ?? false);
      const prevOpenSince = this.ledger.demandState(t.id)?.gateOpenSince;
      const openSince = rawOpen ? (prevOpenSince ?? now) : undefined;
      if (openSince !== prevOpenSince) this.ledger.setGateOpenSince(t.id, openSince);
      const gateOpen =
        rawOpen && openSince !== undefined && now - openSince >= this.cfg.gateDebounceMs;
      // A held lane is still probed: its demand is a signal other lanes' gates
      // read, and a gate that went unevaluable because an unrelated lane was
      // paused would close lanes nobody held.
      const paused = this.ledger.taskPaused(t.id);
      return {
        taskId: t.id,
        tiers: t.tiers,
        share: t.share,
        units,
        gateOpen,
        eligible: !paused && gateOpen && units !== undefined && units > 0,
        paused,
        error: errorOf.get(t.id),
      };
    });

    return { launches: "enabled", tasks: snapshots };
  }
}
