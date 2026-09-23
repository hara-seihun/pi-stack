// The drawer's allowance controls are a direct view of the orchestrator's own
// boost rows: one durable multiplier per provider family on the paced spend its
// broker admits against. The supervisor holds no governor state of its own; it
// reads and writes the orchestrator's ledger and takes what "boosted" means
// from the orchestrator package, so the CLI, the daemon, and both clients agree.
import { BOOSTED_MULTIPLIER, nextBoost } from "pi-orchestrator/boost";
import type { GovernorControls, GovernorProvider, GovernorState } from "./protocol";

export type { GovernorControls, GovernorProvider, GovernorState };

const FAMILIES: Record<GovernorProvider, string> = { openai: "openai-codex", anthropic: "anthropic" };

export function isGovernorProvider(value: string): value is GovernorProvider {
  return value in FAMILIES;
}

function stateOf(multiplier: number): GovernorState {
  if (multiplier === 0) return "red";
  if (multiplier === 1) return "off";
  return multiplier >= BOOSTED_MULTIPLIER ? "blue" : "green";
}

export interface BoostLedger { boost(family: string): number; setBoost(family: string, multiplier: number): void }

export function governorControls(ledger: BoostLedger): GovernorControls | null {
  try {
    const controls = {} as GovernorControls;
    for (const [provider, family] of Object.entries(FAMILIES) as [GovernorProvider, string][]) {
      const multiplier = ledger.boost(family);
      controls[provider] = { state: stateOf(multiplier), boosted: multiplier > 1, multiplier, boostedMultiplier: BOOSTED_MULTIPLIER };
    }
    return controls;
  } catch {
    // An orchestrator ledger without boost custody is not an error here:
    // clients hide the controls when governors is null.
    return null;
  }
}

export function toggleGovernor(ledger: BoostLedger, provider: GovernorProvider): GovernorControls {
  const family = FAMILIES[provider];
  ledger.setBoost(family, nextBoost(ledger.boost(family)));
  const controls = governorControls(ledger);
  if (!controls) throw new Error("Governor controls are unavailable");
  return controls;
}
