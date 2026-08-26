import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ORCHESTRATOR_CATALOG, catalogMeter, type PlanDefinition } from "./catalog.js";
import { Ledger, type AccountRow, type RunRow } from "./ledger/ledger.js";
import { AnthropicMeterSampler } from "./meters/anthropic.js";
import type { TranscriptLive } from "./host/transcript.js";

export interface PlanMetricUsage {
  readonly percentLeft: number | null;
  readonly expectedPercentLeft: number | null;
  readonly paceDelta: number | null;
}

export interface PlanUsage {
  readonly state: "ready" | "partial" | "unavailable";
  readonly metrics: Readonly<Record<string, PlanMetricUsage>>;
  readonly planCount: number;
  readonly checkedCount: number;
}

export interface PlanUsageSnapshot {
  readonly plans: Readonly<Record<string, PlanUsage>>;
  readonly updatedAt: string;
}

export interface ObservedRun extends RunRow {
  readonly observable: boolean;
  readonly live: TranscriptLive | null;
}

export interface RunListing {
  readonly runs: readonly ObservedRun[];
  readonly running: number;
  readonly models: readonly { model: string; count: number }[];
}

export interface TranscriptTail {
  readonly run: ObservedRun | null;
  readonly size: number;
  readonly offset: number;
  readonly next: number;
  readonly chunk: string;
}

/** The complete read surface an operator client needs. It deliberately uses
 * domain rows rather than exposing the ledger's SQLite schema. */
export interface OrchestratorObserver {
  listRuns(limit: number): Promise<RunListing>;
  tailRun(runId: string, offset: number, maxBytes: number, watch: boolean): Promise<TranscriptTail>;
  close(): void;
}

interface AccountMetric {
  readonly percentLeft: number;
  readonly expectedPercentLeft: number | null;
  readonly weight: number;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));
const weightedMean = (values: readonly { value: number; weight: number }[]): number | null => {
  const weight = values.reduce((sum, item) => sum + item.weight, 0);
  return weight <= 0 ? null : values.reduce((sum, item) => sum + item.value * item.weight, 0) / weight;
};
const rounded = (value: number | null): number | null => value === null ? null : Math.round(value);

function currentMetric(
  ledger: Ledger,
  accountId: string,
  meters: readonly string[],
  maxAgeMs: number,
  now: number,
): Omit<AccountMetric, "weight"> | null {
  const values = meters.flatMap((meterId): Omit<AccountMetric, "weight">[] => {
    const meter = catalogMeter(meterId);
    if (meter === undefined) throw new Error(`plan references unknown meter ${meterId}`);
    const reading = ledger.latestReading(accountId, meter.id);
    if (reading === undefined || reading.at > now + 60_000 || now - reading.at > maxAgeMs) return [];
    const reset = reading.resetAt;
    if (reset !== undefined && reset <= now) return [{ percentLeft: 100, expectedPercentLeft: null }];
    const expected = reset === undefined
      ? null
      : clampPercent((reset - now) * 100 / (meter.windowHours * 3_600_000));
    return [{ percentLeft: clampPercent(100 - reading.usedPercent), expectedPercentLeft: expected }];
  });
  return values.sort((left, right) => left.percentLeft - right.percentLeft)[0] ?? null;
}

function projectPlan(ledger: Ledger, plan: PlanDefinition, now: number): PlanUsage {
  const accounts = ledger.accounts().filter((account) =>
    account.provider === plan.provider && (account.accessUntil === undefined || account.accessUntil > now));
  const coverage: number[] = [];
  const metrics: Record<string, PlanMetricUsage> = {};
  for (const metric of plan.metrics) {
    const values = accounts.map((account): AccountMetric | null => {
      const value = currentMetric(ledger, account.id, metric.meters, plan.maxReadingAgeMs, now);
      return value === null ? null : { ...value, weight: account.capacityWeight };
    });
    const available = values.filter((value): value is AccountMetric => value !== null);
    const timed = available.filter((value): value is AccountMetric & { expectedPercentLeft: number } =>
      value.expectedPercentLeft !== null);
    if (available.length > 0) coverage.push(available.length);
    const percentLeft = weightedMean(available.map((value) => ({ value: value.percentLeft, weight: value.weight })));
    const expectedPercentLeft = weightedMean(timed.map((value) => ({ value: value.expectedPercentLeft, weight: value.weight })));
    const paceDelta = weightedMean(timed.map((value) => ({ value: value.percentLeft - value.expectedPercentLeft, weight: value.weight })));
    metrics[metric.id] = {
      percentLeft: rounded(percentLeft),
      expectedPercentLeft: rounded(expectedPercentLeft),
      paceDelta: rounded(paceDelta),
    };
  }
  const checkedCount = coverage.length === 0 ? 0 : Math.min(...coverage);
  return {
    state: checkedCount === accounts.length && accounts.length > 0
      ? "ready"
      : checkedCount > 0 ? "partial" : "unavailable",
    metrics,
    planCount: accounts.length,
    checkedCount,
  };
}

export function tailRange(
  size: number,
  offset: number,
  maxBytes: number,
): { start: number; end: number; fresh: boolean } {
  const fresh = offset < 0 || offset > size;
  const start = fresh ? Math.max(0, size - maxBytes) : offset;
  return { start, end: Math.min(size, start + maxBytes), fresh };
}

function alignedTail(
  data: Buffer,
  start: number,
  end: number,
  size: number,
  fresh: boolean,
): { chunk: string; offset: number; next: number } {
  let body = data;
  let offset = start;
  if (fresh && start > 0) {
    const newline = body.indexOf(0x0a);
    if (newline < 0) return { chunk: "", offset: end, next: end };
    body = body.subarray(newline + 1);
    offset = start + newline + 1;
  }
  if (end < size) {
    const newline = body.lastIndexOf(0x0a);
    if (newline < 0) return { chunk: "", offset, next: end };
    body = body.subarray(0, newline + 1);
  }
  return { chunk: body.toString("utf8"), offset, next: offset + body.length };
}

function liveState(directory: string): TranscriptLive | null {
  try {
    return JSON.parse(readFileSync(join(directory, "live.json"), "utf8")) as TranscriptLive;
  } catch {
    return null;
  }
}

function markWatched(directory: string): void {
  if (!existsSync(directory)) return;
  const marker = join(directory, "watch");
  try {
    if (existsSync(marker)) {
      const stamp = new Date();
      utimesSync(marker, stamp, stamp);
    } else {
      mkdirSync(directory, { recursive: true });
      writeFileSync(marker, "", { mode: 0o600 });
    }
  } catch {
    // Observation remains read-only when a purged or foreign run cannot be marked.
  }
}

export interface OrchestratorClientOptions {
  readonly ledgerPath: string;
  readonly runsRoot: string;
}

/**
 * In-process client for the orchestrator's durable public model. Scheduling,
 * plan cards, voice account selection, governor controls, and run observation
 * now cross this boundary instead of each querying private tables themselves.
 */
export class OrchestratorClient implements OrchestratorObserver {
  private readonly ledger: Ledger;

  constructor(private readonly options: OrchestratorClientOptions) {
    this.ledger = Ledger.open(options.ledgerPath);
  }

  accounts(provider?: string, now = Date.now()): AccountRow[] {
    return this.ledger.accounts().filter((account) =>
      (provider === undefined || account.provider === provider) &&
      (account.accessUntil === undefined || account.accessUntil > now));
  }

  boost(provider: string): number {
    return this.ledger.boost(provider);
  }

  setBoost(provider: string, multiplier: number): void {
    this.ledger.setBoost(provider, multiplier);
  }

  plans(definitions: readonly PlanDefinition[] = ORCHESTRATOR_CATALOG.plans, now = Date.now()): PlanUsageSnapshot {
    return {
      plans: Object.fromEntries(definitions.map((plan) => [plan.id, projectPlan(this.ledger, plan, now)])),
      updatedAt: new Date(now).toISOString(),
    };
  }

  /** Poll facts available only in this user's credential custody. Other
   * provider samplers live in the controller and write into the same ledger. */
  async refreshPlanFacts(agentDir: string): Promise<void> {
    await new AnthropicMeterSampler(this.ledger, { agentDir }).sample();
  }

  async listRuns(limit: number): Promise<RunListing> {
    const running = this.ledger.runs({ state: "running" })
      .sort((left, right) => right.startedAt - left.startedAt);
    const models = new Map<string, number>();
    for (const run of running) models.set(run.model, (models.get(run.model) ?? 0) + 1);
    return {
      runs: running.slice(0, limit).map((run) => this.decorate(run)),
      running: running.length,
      models: [...models].sort(([left], [right]) => left.localeCompare(right))
        .map(([model, count]) => ({ model, count })),
    };
  }

  async tailRun(runId: string, offset: number, maxBytes: number, watch: boolean): Promise<TranscriptTail> {
    const row = this.ledger.run(runId);
    const directory = join(this.options.runsRoot, runId);
    const file = join(directory, "events.jsonl");
    let size = 0;
    try { size = statSync(file).size; } catch { /* No transcript is a valid run state. */ }
    const range = tailRange(size, offset, maxBytes);
    let data = Buffer.alloc(0);
    if (range.end > range.start) {
      const handle = openSync(file, "r");
      try {
        const buffer = Buffer.allocUnsafe(range.end - range.start);
        const read = readSync(handle, buffer, 0, buffer.length, range.start);
        data = buffer.subarray(0, read);
      } finally {
        closeSync(handle);
      }
    }
    if (watch && row?.state === "running") markWatched(directory);
    return {
      run: row === undefined ? null : this.decorate(row),
      size,
      ...alignedTail(data, range.start, range.end, size, range.fresh),
    };
  }

  close(): void {
    this.ledger.close();
  }

  private decorate(run: RunRow): ObservedRun {
    const directory = join(this.options.runsRoot, run.id);
    return {
      ...run,
      observable: existsSync(join(directory, "events.jsonl")),
      live: liveState(directory),
    };
  }
}
