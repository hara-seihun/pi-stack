import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Ledger } from "../ledger/ledger.js";
import { AnthropicMeterSampler } from "../meters/anthropic.js";
import type { MeterReading, UsageSource } from "../calibrator/types.js";

/**
 * Records every pi session's usage into the orchestrator ledger, making all
 * machine usage observed rather than estimated:
 *
 * - `message_end`: one usage event per token component (input/output/cache),
 *   attributed to the provider alias, which is the account identity.
 * - `after_provider_response`: provider rate-limit headers parsed into meter
 *   readings with exact timestamps -- no separate polling.
 *
 * On a machine where every pi session loads this extension, the calibrator's
 * leak term is an alarm, not an estimate: nonzero leak means broken
 * instrumentation or off-machine account usage.
 */

const COMPONENTS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const LEASE_HEARTBEAT_MS = 30_000;

/** The same flag the broker sets to claim a session's account custody names
 * who is spending: a broker-assigned session is the fleet, anything else is
 * this machine's own operator work. Recording both as one source made the
 * fleet's burn and the operator's indistinguishable in the ledger. */
const SOURCE: UsageSource = process.env.PI_ORCHESTRATOR_ASSIGNED === "1" ? "orchestrator" : "machine";

export function defaultLedgerPath(): string {
  return (
    process.env.PI_ORCHESTRATOR_LEDGER ??
    join(homedir(), ".local/share/pi-orchestrator/ledger.sqlite3")
  );
}

/** `anthropic-3` -> `anthropic`; account aliases keep their base provider. */
export function baseProvider(providerAlias: string): string {
  return providerAlias.replace(/-\d+$/, "");
}

/** pi agent directory of the user this session runs as: its auth.json is the
 * credential custody for this session's accounts. */
function agentDirPath(): string {
  return process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Anthropic stamps its unified meters on every response (names verified
 * against recorded production traffic): 5h, 7d, and the model-scoped 7d_oi
 * weekly. Utilization is a fraction with 1% granularity.
 *
 * This is a complete record of *this response*, not of the account: the
 * 7d_oi header appears only on traffic scoped to that model, and no header
 * can report a drain that happened on another machine. The meter sampler
 * beside this extension polls the account usage endpoint to close both gaps.
 */
export function anthropicMeterReadings(
  headers: Record<string, string>,
  at: number,
): { meterId: string; reading: MeterReading }[] {
  const out: { meterId: string; reading: MeterReading }[] = [];
  for (const window of ["5h", "7d", "7d_oi"]) {
    const utilization = headers[`anthropic-ratelimit-unified-${window}-utilization`];
    if (utilization === undefined) continue;
    const resetSeconds = Number(headers[`anthropic-ratelimit-unified-${window}-reset`]);
    out.push({
      meterId: `anthropic-${window}`,
      reading: {
        at,
        usedPercent: Math.round(Number(utilization) * 100),
        resetAt: Number.isFinite(resetSeconds) ? resetSeconds * 1000 : undefined,
      },
    });
  }
  return out;
}

export default function usageLogger(pi: ExtensionAPI): void {
  let ledger: Ledger | undefined;
  let lastErrorLog = 0;
  let activeLease: string | undefined;
  let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
  let anthropicSampler: AnthropicMeterSampler | undefined;
  let anthropicPoll: Promise<unknown> | undefined;
  const knownAccounts = new Set<string>();

  const open = (): Ledger => (ledger ??= Ledger.open(defaultLedgerPath()));

  /**
   * Fills the meters this session's response headers cannot report, for the
   * accounts credentialed in this user's agent dir. Due-gated inside the
   * sampler, so a busy session polls at most once per interval, and never
   * awaited: plan meters are worth a background request, never a pause
   * between the provider's response and the agent's next step.
   */
  const pollAnthropicMeters = (l: Ledger): void => {
    if (anthropicPoll !== undefined) return;
    anthropicSampler ??= new AnthropicMeterSampler(l, { agentDir: agentDirPath() });
    anthropicPoll = anthropicSampler
      .sample()
      .catch((thrown) => {
        if (Date.now() - lastErrorLog > 60_000) {
          lastErrorLog = Date.now();
          console.error(`pi-orchestrator usage-logger: anthropic meter poll: ${String(thrown)}`);
        }
      })
      .finally(() => {
        anthropicPoll = undefined;
      });
  };

  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (thrown) {
      if (Date.now() - lastErrorLog > 60_000) {
        lastErrorLog = Date.now();
        console.error(`pi-orchestrator usage-logger: ${String(thrown)}`);
      }
    }
  };

  const ensureAccount = (l: Ledger, providerAlias: string): void => {
    if (knownAccounts.has(providerAlias)) return;
    l.upsertAccount({ id: providerAlias, provider: baseProvider(providerAlias) });
    knownAccounts.add(providerAlias);
  };

  const endLease = (): void => {
    if (leaseHeartbeat !== undefined) clearInterval(leaseHeartbeat);
    leaseHeartbeat = undefined;
    if (activeLease !== undefined) {
      const id = activeLease;
      activeLease = undefined;
      guard(() => open().endSessionLease(id, Date.now()));
    }
  };

  if (process.env.PI_ORCHESTRATOR_ASSIGNED !== "1") {
    pi.on("agent_start", async (_event, ctx) => {
      endLease();
      const providerAlias = ctx.model?.provider;
      if (providerAlias === undefined) return;
      guard(() => {
        const l = open();
        ensureAccount(l, providerAlias);
        activeLease = l.beginSessionLease(providerAlias, Date.now());
        leaseHeartbeat = setInterval(() => {
          if (activeLease !== undefined) guard(() => open().heartbeatSessionLease(activeLease!, Date.now()));
        }, LEASE_HEARTBEAT_MS);
      });
    });
    pi.on("agent_end", async () => endLease());
  }

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const { provider, model, usage } = event.message;
    if (!usage) return;
    guard(() => {
      const l = open();
      ensureAccount(l, provider);
      const at = Date.now();
      const sessionId = ctx.sessionManager.getSessionId();
      const events = COMPONENTS.flatMap((component) => {
        const tokens = usage[component];
        return tokens > 0
          ? [{ at, classId: `${model}:${component}`, tokens, source: SOURCE, sessionId }]
          : [];
      });
      if (events.length > 0) l.recordUsageBatch(provider, events);
    });
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const providerAlias = ctx.model?.provider;
    if (!providerAlias || baseProvider(providerAlias) !== "anthropic") return;
    guard(() => {
      const l = open();
      ensureAccount(l, providerAlias);
      for (const { meterId, reading } of anthropicMeterReadings(event.headers, Date.now())) {
        try {
          l.recordReading(providerAlias, meterId, reading);
        } catch {
          // Concurrent sessions race on readings; a lost redundant reading is fine.
        }
      }
      pollAnthropicMeters(l);
    });
  });

  pi.on("session_shutdown", async () => {
    endLease();
    // The poll writes through this ledger handle, so it must finish before
    // the handle closes; it is bounded by the sampler's request timeout.
    await anthropicPoll;
    ledger?.close();
    ledger = undefined;
    anthropicSampler = undefined;
  });
}
