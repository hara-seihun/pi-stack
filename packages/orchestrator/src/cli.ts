#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BOOSTED_MULTIPLIER } from "./boost.js";
import { Broker } from "./broker/broker.js";
import { Controller } from "./controller/controller.js";
import { Ledger } from "./ledger/ledger.js";
import { Runner, bumpRunnerGeneration } from "./host/runner.js";
import { Scheduler } from "./tasks/scheduler.js";
import { TIERS, type Tier, type TierShare } from "./tasks/types.js";
import { reconcileTaskManifest } from "./task-manifest.js";
import { credentialedAccountIds } from "./auth/credentials.js";
import { brokerConfig, cooldownPolicy, defaultConfigPath, loadConfig } from "./config.js";
import { catalogModel } from "./catalog.js";
import { CURSOR_PROVIDER, CursorMeterSampler } from "./meters/cursor.js";
import { CODEX_PROVIDER, CodexMeterSampler } from "./meters/codex.js";
import { AnthropicMeterSampler } from "./meters/anthropic.js";
import { MeterLog } from "./meters/log.js";
import { VoiceBroker } from "./voice/broker.js";
import { createVoiceServer } from "./voice/server.js";
import type { LaunchSpec } from "./host/types.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  defaultSharedAuthPath,
  dropLocalCredential,
  oauthCredential,
  SharedOAuthAuth,
} from "./auth/shared-oauth.js";

/**
 * Operator CLI. Thin by design: every command is a small read or write
 * against the ledger plus a scheduler evaluation; all policy lives in the
 * library modules. The daemon additionally reconciles the deployment's task
 * manifest before it starts scheduling.
 */

const LEDGER_PATH =
  process.env.PI_ORCHESTRATOR_LEDGER ??
  join(homedir(), ".local", "share", "pi-orchestrator", "ledger.sqlite3");

/** pi agent directory of the user this process runs as: its auth.json is the
 * credential custody for this process's accounts. */
function agentDirPath(): string {
  return (
    process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
  );
}

/** A usage error. Thrown rather than exited, so commands stay testable. */
class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

function flags(args: string[]): { positional: string[]; named: Map<string, string> } {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`flag ${a} needs a value`);
      named.set(a.slice(2), value);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, named };
}

export function namedFlags(
  command: string,
  args: string[],
  allowed: readonly string[],
): Map<string, string> {
  const { positional, named } = flags(args);
  if (positional.length > 0) fail(`${command}: unexpected argument ${positional[0]}`);
  const accepted = new Set(allowed);
  for (const name of named.keys()) {
    if (!accepted.has(name)) fail(`${command}: unknown flag --${name}`);
  }
  return named;
}

async function status(ledger: Ledger): Promise<void> {
  console.log(`ledger: ${LEDGER_PATH}`);
  console.log(`launches: ${ledger.getControl("launches") ?? "enabled"}`);
  for (const b of ledger.boosts()) console.log(`boost ${b.provider}: ${b.multiplier}x allowance`);
  const evaluation = await new Scheduler(ledger).evaluate();
  for (const t of evaluation.tasks) {
    const parts = [
      t.paused ? "held" : t.eligible ? "eligible" : "waiting",
      `units=${t.units ?? "?"}`,
      `gate=${t.gateOpen ? "open" : "closed"}`,
      `tiers=${formatTiers(t.tiers)}`,
      `share=${sharePercent(t, evaluation.tasks)}`,
    ];
    if (t.error !== undefined) parts.push(`error=${t.error}`);
    console.log(`task ${t.taskId}: ${parts.join(" ")}`);
  }
  for (const r of ledger.runs({ state: "pending" })) {
    const role = r.teamRole === undefined ? "" : ` ${r.teamRole}-${r.teamSlot}`;
    console.log(`pending ${r.id.slice(0, 8)}: ${r.taskId}${role} awaiting runner`);
  }
  for (const r of ledger.runs({ state: "running" })) {
    const role = r.teamRole === undefined ? "" : ` ${r.teamRole}-${r.teamSlot}`;
    const idle = r.idleAt === undefined ? "" : ` idle-since=${new Date(r.idleAt).toISOString()}`;
    console.log(
      `run ${r.id.slice(0, 8)}: ${r.taskId}${role}${idle} on ${r.accountId} (${r.model}) runner=${r.runnerId}`,
    );
  }
  // Pausing skips evaluation entirely, so an empty list here means "not
  // evaluated", not "nothing defined" — say which, or the lanes look deleted.
  if (evaluation.tasks.length === 0) {
    const defined = ledger.tasks().length;
    console.log(
      defined === 0
        ? "no tasks"
        : `${defined} task(s) defined, not evaluated while launches are paused (pi-orchestrator task list)`,
    );
  }
}

/**
 * Where the machine's token quota went. Every pi session on this machine
 * logs into the ledger, so this is the whole answer: fleet burn resolved to
 * the lane that spent it, operator burn to the session that spent it, and
 * nothing left over. A number that does not appear here was not spent by a
 * session on this machine.
 */
function usage(ledger: Ledger, args: string[]): void {
  const named = namedFlags("usage", args, ["hours"]);
  const hours = Number(named.get("hours") ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) fail("usage: usage [--hours N]");
  const b = ledger.usageBreakdown(Date.now() - hours * 3_600_000);
  const M = (n: number): string => `${(n / 1e6).toFixed(1)}M`;
  const share = (n: number): string =>
    b.total > 0 ? `${((100 * n) / b.total).toFixed(0).padStart(3)}%` : "   -";
  const table = (title: string, rows: readonly { key: string; tokens: number; sessions: number }[]): void => {
    if (rows.length === 0) return;
    console.log(`\n${title}`);
    for (const r of rows) {
      console.log(`  ${share(r.tokens)} ${M(r.tokens).padStart(8)}  ${String(r.sessions).padStart(4)} sess  ${r.key}`);
    }
  };
  console.log(`last ${hours}h: ${M(b.total)} tokens`);
  console.log(`  ${share(b.bySource.orchestrator)} ${M(b.bySource.orchestrator).padStart(8)}  fleet (orchestrator-launched)`);
  console.log(`  ${share(b.bySource.machine)} ${M(b.bySource.machine).padStart(8)}  this machine (interactive)`);
  table("by lane", b.byLane);
  table("by account", b.byAccount);
  table("by model", b.byModel);
  table("largest sessions", b.topSessions);
}

/**
 * Machine-readable admission and quota facts for external launchers —
 * processes (like the Converge supervisor) that start their own sessions on
 * this machine's pooled accounts and need to size that launch decision from
 * the same ledger facts the broker admits from. Pure read: broker views,
 * latest meter readings, nothing mutated.
 */
function capacity(ledger: Ledger, args: string[]): void {
  const named = namedFlags("capacity", args, ["provider"]);
  const providerFilter = named.get("provider");
  const cfg = loadConfig();
  const broker = new Broker(ledger, brokerConfig(cfg));
  const now = Date.now();
  const external = broker.externalCapacity(now);
  const viewById = new Map(external.accounts.map((v) => [v.id, v]));
  const machineFree = Math.max(0, external.machineCeiling - external.totalActive);
  const providers: Record<string, unknown> = {};
  for (const [provider, providerCfg] of Object.entries(cfg.providers)) {
    if (providerFilter !== undefined && provider !== providerFilter) continue;
    const accounts = ledger
      .accounts()
      .filter((a) => a.provider === provider)
      .map((a) => {
        const view = viewById.get(a.id);
        const meters = providerCfg.meters.map((meter) => {
          const reading = ledger.latestReading(a.id, meter.id);
          return reading === undefined
            ? { id: meter.id }
            : {
                id: meter.id,
                usedPercent: reading.usedPercent,
                readAt: new Date(reading.at).toISOString(),
                ...(reading.resetAt === undefined
                  ? {}
                  : { resetAt: new Date(reading.resetAt).toISOString() }),
              };
        });
        return {
          id: a.id,
          label: a.label,
          eligible: view !== undefined,
          cooling: a.cooldownUntil !== undefined && a.cooldownUntil > now,
          active: view?.active ?? 0,
          sessionCapacity: view?.capacity ?? 0,
          meters,
        };
      });
    const eligible = accounts.filter((a) => a.eligible);
    const remaining = eligible
      .map((a) => {
        const percents = a.meters
          .map((m) => ("usedPercent" in m ? m.usedPercent : undefined))
          .filter((v): v is number => typeof v === "number");
        return percents.length === 0 ? undefined : 100 - Math.max(...percents);
      })
      .filter((v): v is number => v !== undefined);
    const futureResets = eligible
      .flatMap((a) => a.meters.map((m) => ("resetAt" in m ? m.resetAt : undefined)))
      .filter((v): v is string => typeof v === "string")
      .map((v) => Date.parse(v))
      .filter((v) => Number.isFinite(v) && v > now);
    const accountSlots = eligible.reduce(
      (sum, a) => sum + Math.max(0, a.sessionCapacity - a.active),
      0,
    );
    providers[provider] = {
      accounts,
      eligibleAccounts: eligible.length,
      freeSessionSlots: Math.min(accountSlots, machineFree),
      meanRemainingPercent:
        remaining.length === 0
          ? null
          : remaining.reduce((sum, v) => sum + v, 0) / remaining.length,
      minimumRemainingPercent: remaining.length === 0 ? null : Math.min(...remaining),
      nextResetAt:
        futureResets.length === 0 ? null : new Date(Math.min(...futureResets)).toISOString(),
    };
  }
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        machineCeiling: external.machineCeiling,
        totalActiveSessions: external.totalActive,
        providers,
      },
      null,
      2,
    ),
  );
}

/** Controller daemon: the launch loop. Tier→model maps and meter topology
 * come from operator config; everything else is measured. */
async function daemon(ledger: Ledger, args: string[]): Promise<void> {
  const named = namedFlags("daemon", args, ["interval"]);
  const cfg = loadConfig();
  if (cfg.taskManifest !== undefined) {
    const result = reconcileTaskManifest(ledger, cfg.taskManifest);
    console.log(
      `reconciled ${result.upserted} task(s) from ${cfg.taskManifest}` +
      (result.deleted.length === 0 ? "" : `; deleted ${result.deleted.join(", ")}`),
    );
  }
  const controller = new Controller(
    ledger,
    new Scheduler(ledger),
    new Broker(ledger, brokerConfig(cfg)),
    {
      // The daemon runs as the fleet's credential-custody user, so it can
      // observe exactly which accounts the fleet can authenticate: the
      // central shared OAuth store plus its own agent dir's auth.json.
      fleetCredentials: () =>
        credentialedAccountIds([
          defaultSharedAuthPath(LEDGER_PATH),
          join(agentDirPath(), "auth.json"),
        ]),
    },
  );
  const intervalMs = Number(named.get("interval") ?? 30_000);
  // Cursor publishes no meter headers, so its monthly meter is polled here
  // rather than observed by the usage-logger extension. The daemon runs as
  // the credential-custody user, so it can read the token without moving it.
  const cursorMeter = cfg.providers[CURSOR_PROVIDER]?.meters[0];
  const cursorSampler = cursorMeter
    ? new CursorMeterSampler(ledger, { agentDir: agentDirPath(), meterId: cursorMeter.id })
    : undefined;
  // Codex publishes no meter headers to pi's WebSocket transport either, so
  // its windows are polled from the account usage endpoint. Credentials are
  // read (never refreshed) from the shared store first, then this user's own
  // agent dir for any Codex account whose custody was never moved.
  const codexMeters = cfg.providers[CODEX_PROVIDER]?.meters ?? [];
  const codexSampler =
    codexMeters.length > 0
      ? new CodexMeterSampler(ledger, {
          authPaths: [
            defaultSharedAuthPath(LEDGER_PATH),
            join(agentDirPath(), "auth.json"),
          ],
          meters: codexMeters,
        })
      : undefined;
  // Anthropic does publish meter headers, but only for the models a session
  // actually runs and only for traffic on this machine, so an Opus account's
  // Fable meter and any off-machine drain are invisible to the usage-logger.
  // The account usage endpoint reports every bucket on every call; this poll
  // covers the accounts in this user's custody, and each interactive user's
  // own pi sessions poll theirs.
  const anthropicSampler = new AnthropicMeterSampler(ledger, {
    agentDir: agentDirPath(),
    sharedAuthPath: defaultSharedAuthPath(LEDGER_PATH),
  });
  const meterLog = new MeterLog();
  // `no-credential` is the ordinary state of an account held in another
  // custody domain, not a gap this controller can close.
  const anthropicLog = new MeterLog(undefined, ["no-credential"]);
  console.log(`controller started (config: ${defaultConfigPath()})`);
  for (;;) {
    try {
      for (const sample of (await cursorSampler?.sample()) ?? []) {
        meterLog.report({ ...sample, meterId: cursorMeter?.id });
      }
      for (const sample of (await codexSampler?.sample()) ?? []) meterLog.report(sample);
      for (const sample of await anthropicSampler.sample()) anthropicLog.report(sample);
      const report = await controller.tick();
      for (const run of report.created) {
        console.log(`created ${run.id.slice(0, 8)}: ${run.taskId} -> ${run.accountId} (${run.model})`);
      }
      for (const id of report.reaped) console.log(`reaped ${id.slice(0, 8)}: heartbeat timeout`);
      for (const id of report.expired) console.log(`expired ${id.slice(0, 8)}: unclaimed`);
    } catch (thrown) {
      console.error(`tick failed: ${String(thrown)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * GPT-Live voice broker: a loopback HTTP service turning WebRTC SDP offers
 * into answers on this machine's pooled Codex accounts. Runs as the
 * credential-custody user; callers (pi-remote, the Converge meeting
 * runtime, any local script) never see OAuth tokens.
 */
async function voiceBroker(ledger: Ledger, args: string[]): Promise<void> {
  const named = namedFlags("voice-broker", args, ["listen"]);
  const listen = named.get("listen") ?? "127.0.0.1:2457";
  const separator = listen.lastIndexOf(":");
  const host = separator > 0 ? listen.slice(0, separator) : "127.0.0.1";
  const port = Number(listen.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`voice-broker: invalid --listen ${listen}`);
  const authPath = defaultSharedAuthPath(LEDGER_PATH);
  const broker = new VoiceBroker({ authPath, accounts: () => ledger.accounts() });
  const server = createVoiceServer(broker);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const initial = broker.status();
  console.log(`voice broker listening on ${host}:${port} (${initial.accountCount} eligible accounts, auth ${authPath})`);
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  server.close();
}

/**
 * Runner process: claims pending runs and hosts them as embedded pi
 * sessions. Separate from the controller so orchestrator updates never kill
 * agents; drains (finishes current sessions, claims nothing) when the
 * runner generation is bumped, then exits.
 */
async function runner(ledger: Ledger, args: string[]): Promise<void> {
  const named = namedFlags("runner", args, ["id", "max-sessions", "interval"]);
  // Hosted sessions must never be re-routed by the interactive routing
  // extension: the broker assigned their account.
  process.env.PI_ORCHESTRATOR_ASSIGNED = "1";
  process.env.PI_BASH_TIMEOUT_MAX_SECONDS = "55";
  process.env.PI_BASH_TIMEOUT_CONTEXT = "This shared runner has the same ceiling.";
  const { PiHost } = await import("./host/pi-host.js");
  const { DEFAULT_RUNS_ROOT, pruneTranscripts } = await import("./host/transcript.js");
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const families = new Map(builtinProviders().map((p) => [p.id, p]));
  // Builtin family models resolve here so an alias account can be re-homed
  // onto them before the session exists. Anything else — a model served by an
  // extension provider — is left to the session's own model runtime, the only
  // place that provider is registered.
  const resolveModel = (spec: LaunchSpec): unknown => {
    const model = families.get(spec.provider)?.getModels().find((m) => m.id === spec.model);
    if (model === undefined) return undefined;
    return spec.accountId === spec.provider ? model : { ...model, provider: spec.accountId };
  };
  const runsRoot = DEFAULT_RUNS_ROOT;
  const pruned = pruneTranscripts(runsRoot);
  if (pruned > 0) console.log(`pruned ${pruned} expired run transcript(s)`);
  const runnerId = named.get("id") ?? `${hostname()}-${process.pid}`;
  const engine: InstanceType<typeof PiHost> = new PiHost(
    // The runner is constructed below; PiHost only needs the event surface.
    { runFinished: (id, result, at) => live.runFinished(id, result, at),
      heartbeat: (id, at) => live.heartbeat(id, at),
      progress: (id, at) => live.progress(id, at),
      sessionStarted: (id, sessionId, sessionFile) => live.sessionStarted(id, sessionId, sessionFile),
      teamWorkerIdle: (workerRunId) => live.teamWorkerIdle(workerRunId),
      teamSupervisorResponded: (supervisorRunId, workerRunId, idleAt, text) =>
        live.teamSupervisorResponded(supervisorRunId, workerRunId, idleAt, text),
      teamWorkerSession: (supervisorRunId, workerRunId) =>
        live.teamWorkerSession(supervisorRunId, workerRunId),
      laneDrained: (taskId) => live.laneDrained(taskId),
      claimCheckIn: (runId) => live.claimCheckIn(runId),
      turnFailed: (runId, detail, attempt) => {
        const waitMs = live.turnFailed(runId, detail, attempt);
        const id = runId.slice(0, 8);
        const why = detail.slice(0, 200);
        console.log(
          waitMs === undefined
            ? `${id}: provider failed the turn, nothing to wait for: ${why}`
            : `${id}: provider failed the turn (attempt ${attempt}), waiting ${Math.round(
                waitMs / 1000,
              )}s: ${why}`,
        );
        return waitMs;
      } },
    {
      resolveModel,
      runsRoot,
    },
  );
  const live = new Runner(ledger, engine, {
    runnerId,
    maxSessions: Number(named.get("max-sessions") ?? 100),
    cooldown: cooldownPolicy(loadConfig()),
  });
  const intervalMs = Number(named.get("interval") ?? 5000);
  console.log(`runner ${runnerId} started`);
  for (;;) {
    const report = live.tick();
    for (const spec of report.claimed) console.log(`claimed ${spec.runId}: ${spec.taskId}`);
    for (const runId of report.stalled) console.log(`tore down ${runId}: session stopped`);
    if (live.drained()) {
      console.log(`runner ${runnerId} drained, exiting`);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Runner supervisor: the long-lived process a service unit should run.
 * It hosts no session itself, and keeps exactly one runner worker of the
 * current generation alive as a child process, so a `drain-runners` bump
 * starts the successor immediately instead of waiting for the drained
 * process to exit. Workers are spawned from this same CLI path, which is
 * the deployed artifact, so each new worker starts on the newest build.
 */
async function supervisor(ledger: Ledger, args: string[]): Promise<void> {
  const named = namedFlags("supervisor", args, ["id", "max-sessions", "interval"]);
  const { RunnerSupervisor } = await import("./host/supervisor.js");
  const { spawn } = await import("node:child_process");
  const entry = process.argv[1] ?? fail("supervisor cannot resolve its own CLI path");
  const intervalMs = Number(named.get("interval") ?? 5000);
  const live: InstanceType<typeof RunnerSupervisor> = new RunnerSupervisor(
    ledger,
    (spec) => {
      const child = spawn(
        process.execPath,
        [
          entry,
          "runner",
          "--id", spec.workerId,
          "--max-sessions", String(spec.maxSessions),
          "--interval", String(intervalMs),
        ],
        { stdio: "inherit" },
      );
      console.log(`spawned worker ${spec.workerId} (generation ${spec.generation}) pid ${child.pid}`);
      const ended = (detail: string): void => {
        console.log(`worker ${spec.workerId} ended: ${detail}`);
        live.workerExited(spec.workerId);
      };
      child.once("error", (error) => ended(String(error)));
      child.once("exit", (code, signal) => ended(signal ?? `exit ${code ?? 0}`));
    },
    {
      runnerId: named.get("id") ?? hostname(),
      maxSessions: Number(named.get("max-sessions") ?? 100),
    },
  );
  const orphans = live.reapOrphans();
  if (orphans.length > 0) {
    console.log(`reaped ${orphans.length} run(s) whose worker died with the last supervisor`);
  }
  console.log(`runner supervisor started (interval ${intervalMs}ms)`);
  for (;;) {
    live.tick();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Say something to a live agent. Aborting used to be the only lever an
 * operator had over a running session, which made every correction cost the
 * agent's whole context. The queued row is the request; the runner that owns
 * the session delivers it as a user turn, so this waits for the receipt
 * rather than reporting a write as if it were an arrival.
 */
async function say(ledger: Ledger, args: string[]): Promise<void> {
  const [runId, ...words] = args;
  if (runId === undefined || words.length === 0) fail("say <runId> <text...>");
  const run = ledger.run(runId as string) ?? fail(`unknown run ${runId as string}`);
  if (run.state !== "running") fail(`run ${run.id} is ${run.state}; only a running session listens`);
  const id = ledger.queueRunMessage(run.id, words.join(" "));
  // A runner ticks about once a second; wait a few of those before saying
  // anything, because "queued" and "the agent has it" are different facts.
  for (let waited = 0; waited < 15_000; waited += 500) {
    if (!ledger.pendingRunMessages(run.id).some((m) => m.id === id)) {
      console.log(`delivered to ${run.id} (${run.taskId} on ${run.accountId})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(
    `queued for ${run.id}, not yet delivered: its runner may be down, or the run ended. ` +
      `It is delivered when the owning runner next ticks, and never after the run finishes.`,
  );
}

/** Taking an account into shared custody moves its credential there; a
 * per-user copy left behind is a duplicate of the same secret. */
function reportLocalCopy(id: string): void {
  const local = join(agentDirPath(), "auth.json");
  if (dropLocalCredential(local, id)) console.log(`removed the superseded copy in ${local}`);
  console.log(
    `if ${id} was ever logged in as another user, delete its entry from that user's auth.json too`,
  );
}

function sharedOAuthAuth(providerId: string): SharedOAuthAuth {
  const oauth = builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
  if (oauth === undefined) throw new Error(`${providerId} OAuth is unavailable`);
  return new SharedOAuthAuth({
    path: defaultSharedAuthPath(LEDGER_PATH),
    providerId,
    refresh: (credential, signal) => oauth.refresh(credential, signal),
    toAuth: (credential) => oauth.toAuth(credential),
    identity: providerId === "openai-codex"
      ? (credential) => {
          const accountId = (credential as { accountId?: unknown }).accountId;
          return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
        }
      : undefined,
  });
}

/**
 * How the stored credential for an account looks from this process, for
 * `account list`. An account whose access token has expired still works —
 * the next pi session that runs it refreshes on use — but nothing else can
 * read its meters until then, so an idle or cooling account can sit blind
 * for a day. That is worth being able to see without reading the journal.
 */
function credentialState(accountId: string, now = Date.now()): string | undefined {
  for (const path of [defaultSharedAuthPath(LEDGER_PATH), join(agentDirPath(), "auth.json")]) {
    let stored: unknown;
    try {
      stored = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[accountId];
    } catch {
      continue;
    }
    if (stored === null || typeof stored !== "object") continue;
    const credential = stored as { type?: unknown; expires?: unknown };
    if (credential.type !== "oauth") return "credential=api-key";
    if (typeof credential.expires !== "number") return "credential=oauth";
    return credential.expires <= now
      ? `credential=expired-at=${new Date(credential.expires).toISOString()}`
      : `credential_expires=${new Date(credential.expires).toISOString()}`;
  }
  return undefined;
}

async function accountCommand(ledger: Ledger, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    for (const a of ledger.accounts()) {
      const parts = [
        `provider=${a.provider}`,
        `custody=${a.shared ? "shared" : a.fleetCredentialed ? "fleet" : "local"}`,
      ];
      const credential = credentialState(a.id);
      if (credential !== undefined) parts.push(credential);
      if (a.label !== undefined) parts.push(`label=${a.label}`);
      if (a.capacityWeight !== 1) parts.push(`capacity_weight=${a.capacityWeight}`);
      if (a.accessUntil !== undefined) parts.push(`access_until=${new Date(a.accessUntil).toISOString()}`);
      if (a.cooldownUntil !== undefined && a.cooldownUntil > Date.now())
        parts.push(`cooling_until=${new Date(a.cooldownUntil).toISOString()}`);
      console.log(`${a.id}: ${parts.join(" ")}`);
    }
  } else if (sub === "add") {
    const { positional, named } = flags(rest);
    const id = positional[0] ?? fail("account add <id> --provider FAMILY required");
    const provider = named.get("provider") ?? fail("--provider required");
    const shared = named.get("shared");
    if (shared !== undefined && shared !== "true" && shared !== "false") fail("--shared must be true or false");
    if (shared === "true" && builtinProviders().find((candidate) => candidate.id === provider)?.auth.oauth === undefined) {
      fail(`${provider} does not support shared OAuth custody`);
    }
    ledger.upsertAccount({
      id,
      provider,
      label: named.get("label"),
      shared: shared === undefined ? undefined : shared === "true",
    });
    console.log(
      `account ${id} saved; which runtime can spend it follows from where its credential lives`,
    );
  } else if (sub === "remove") {
    const id = rest[0] ?? fail("usage: account remove <id>");
    const removed = ledger.removeAccount(id);
    console.log(
      `account ${id} removed with ${removed.usageEvents} usage events and ` +
        `${removed.meterReadings} meter readings. Delete its credential from its owning ` +
        "local or shared auth store too.",
    );
  } else if (sub === "share") {
    const [id, value = "on"] = rest;
    if (id === undefined || (value !== "on" && value !== "off")) fail("usage: account share <id> [on|off]");
    const account = ledger.accounts().find((row) => row.id === id) ?? fail(`unknown account ${id}`);
    const shared = sharedOAuthAuth(account.provider);
    if (value === "on" && !shared.has(id)) {
      const localPath = join(agentDirPath(), "auth.json");
      let local: Record<string, unknown> = {};
      try {
        local = JSON.parse(readFileSync(localPath, "utf8")) as Record<string, unknown>;
      } catch {}
      const credential = oauthCredential(local[id]);
      if (credential === undefined) {
        fail(`${id} has no OAuth credential in ${localPath} or ${defaultSharedAuthPath(LEDGER_PATH)}`);
      }
      await shared.set(id, credential);
      console.log(`moved ${id} into ${defaultSharedAuthPath(LEDGER_PATH)}`);
    }
    ledger.setAccountShared(id, value === "on");
    console.log(`account ${id} custody is now ${value === "on" ? "shared" : "its credential store's"}`);
    if (value === "on") reportLocalCopy(id);
  } else if (sub === "login") {
    const id = rest[0] ?? fail("usage: account login <id>");
    const account = ledger.accounts().find((row) => row.id === id) ?? fail(`unknown account ${id}`);
    if (account.provider !== "openai-codex") fail("shared login currently supports openai-codex only");
    const oauth = builtinProviders().find((provider) => provider.id === "openai-codex")?.auth.oauth;
    if (oauth === undefined) throw new Error("OpenAI Codex OAuth is unavailable");
    const credential = await oauth.login({
      signal: new AbortController().signal,
      prompt: async (prompt) => {
        if (prompt.type === "select" && prompt.options.some((option) => option.id === "device_code")) {
          return "device_code";
        }
        throw new Error(`Unexpected Codex login prompt: ${prompt.message}`);
      },
      notify: (event) => {
        if (event.type === "device_code") {
          console.log(`Open ${event.verificationUri} and enter code ${event.userCode}`);
        } else if (event.type === "auth_url") {
          console.log(`Open ${event.url}`);
        } else if (event.type === "progress" || event.type === "info") {
          console.log(event.message);
        }
      },
    });
    await sharedOAuthAuth(account.provider).set(id, credential);
    ledger.setAccountShared(id, true);
    console.log(`account ${id} authenticated into shared custody`);
    reportLocalCopy(id);
  } else
    fail(
      "usage: account list | account add <id> --provider F [--label L] [--shared true] | " +
        "account remove <id> | account share <id> [on|off] | account login <id>",
    );
}


function boostCommand(ledger: Ledger, args: string[]): void {
  const [family, value] = args;
  if (family === undefined) {
    const boosts = ledger.boosts();
    if (boosts.length === 0) console.log("no family is boosted");
    for (const b of boosts) console.log(`${b.provider}: ${b.multiplier}x`);
    return;
  }
  if (value === undefined) {
    console.log(`${family}: ${ledger.boost(family)}x`);
    return;
  }
  const multiplier =
    value === "on" ? BOOSTED_MULTIPLIER : value === "off" ? 1 : value === "halt" ? 0 : Number(value);
  if (!Number.isFinite(multiplier) || multiplier < 0) fail("usage: boost <family> [on|off|halt|N>=0]");
  ledger.setBoost(family, multiplier);
  console.log(
    multiplier === 0
      ? `${family}: halted — no new launches; running sessions finish naturally`
      : `${family}: ${multiplier}x allowance`,
  );
}

/**
 * `light:20,standard` — a tier list with optional relative weights, which is
 * how a lane asks to be worked by a mix ("twenty light sessions per standard
 * one") rather than by substitution alone. An unweighted tier is weight 1, so
 * the plain `light,standard` form means an even split.
 */
function parseTiers(value: string | undefined): TierShare[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => {
    const [name, weight] = entry.split(":");
    const tier = name.trim() as Tier;
    if (!TIERS.includes(tier)) fail(`unknown tier ${name}`);
    if (weight === undefined) return { tier, weight: 1 };
    const parsed = Number(weight);
    if (!Number.isFinite(parsed) || parsed <= 0) fail(`tier ${tier}: weight must be positive`);
    return { tier, weight: parsed };
  });
}

const formatTiers = (tiers: readonly TierShare[]): string =>
  tiers.map((s) => (tiers.length === 1 ? s.tier : `${s.tier}:${s.weight}`)).join(",");

/** A lane's share is only meaningful against the other eligible lanes, so it
 * is shown as the fraction of the fleet it is currently claiming rather than
 * as a bare weight an operator would have to normalize by hand. A lane that
 * is not claiming anything — held, gated, out of work — gets no percentage:
 * normalizing a bystander against the eligible lanes printed "share=14
 * (700%)" for a lane launching nothing at all.
 *
 * The fraction is of claims, not of bare shares: share scales a lane's whole
 * tier bundle, so a share-14 lane wanting twenty light sessions per standard
 * one claims twenty-one times what a share-14 single-tier lane would. Naming
 * the fleet fraction as 14/(14+2) told the operator to expect 88% of the
 * machine for a lane that in fact claims 99% of it. */
export function sharePercent(
  task: { share?: number; eligible: boolean; tiers: readonly TierShare[] },
  tasks: readonly { share?: number; eligible: boolean; tiers: readonly TierShare[] }[],
): string {
  const weight = task.share ?? 1;
  if (!task.eligible) return `${weight}`;
  const claim = (t: { share?: number; tiers: readonly TierShare[] }): number =>
    (t.share ?? 1) * t.tiers.reduce((sum, s) => sum + s.weight, 0);
  const total = tasks.filter((t) => t.eligible).reduce((sum, t) => sum + claim(t), 0);
  return total > 0 ? `${weight} (${Math.round((100 * claim(task)) / total)}%)` : `${weight}`;
}

/**
 * Launch control at two scopes, one lever. `pause` holds the machine,
 * `pause <lane>` holds one lane, and `pause --except <lane>` holds every
 * other defined lane, which is how the whole fleet is pointed at one lane
 * without deleting the definitions of the rest. A held lane is still probed
 * and still feeds other lanes' gates; it simply never launches.
 */
export function launchControl(ledger: Ledger, command: "pause" | "resume", args: string[]): void {
  const { positional, named } = flags(args);
  const defined = ledger.tasks().map((t) => t.id);
  const holding = command === "pause";
  const except = named.get("except");
  if (except !== undefined) {
    if (!holding) fail("--except belongs to pause: resume <task...> releases named lanes");
    if (positional.length > 0) fail("pause takes task ids or --except, not both");
    const kept = new Set(except.split(",").map((id) => id.trim()));
    for (const id of kept) if (!defined.includes(id)) fail(`unknown task ${id}`);
    for (const id of defined) ledger.setTaskPaused(id, !kept.has(id));
    console.log(
      `lanes held except ${[...kept].join(", ")}; a lane defined later starts unheld`,
    );
    return;
  }
  if (positional.length === 0) {
    ledger.setControl("launches", holding ? "paused" : "enabled");
    console.log(holding ? "launches paused (running agents unaffected)" : "launches enabled");
    return;
  }
  for (const id of positional) {
    if (!defined.includes(id)) fail(`unknown task ${id}`);
    ledger.setTaskPaused(id, holding);
    console.log(`lane ${id} ${holding ? "held (running agents unaffected)" : "released"}`);
  }
}

// Editing one field of a live task must not silently discard the others, so
// flags are merged over the existing row. A field is cleared by passing it
// empty (--gate ""), which is the only way to say "remove this" out loud.
export function taskSet(ledger: Ledger, args: string[]): void {
  const { positional, named } = flags(args);
  const id = positional[0] ?? fail("task set <id> --tiers ... required");
  const current = ledger.tasks().find((t) => t.id === id);
  const pick = (flag: string, fallback: string | undefined): string | undefined => {
    if (!named.has(flag)) return fallback;
    const value = named.get(flag);
    return value === "" ? undefined : value;
  };

  const tiers =
    parseTiers(named.get("tiers")) ??
    current?.tiers ??
    fail(`--tiers required: ${id} does not exist yet`);

  const share = named.has("share") ? Number(named.get("share")) : current?.share;
  if (share !== undefined && (!Number.isFinite(share) || share <= 0)) {
    fail("--share must be a positive number");
  }

  // The two demand forms are exclusive, so naming one clears the other.
  const demandCommand = pick(
    "demand-command",
    named.has("demand-constant") ? undefined : current?.demandCommand,
  );
  const demandConstant = named.has("demand-constant")
    ? Number(named.get("demand-constant"))
    : named.has("demand-command")
      ? undefined
      : current?.demandConstant;

  // Opening-exchange messages are authored in files and captured into the
  // ledger at set time: the row is the source of truth for what launches
  // say, and editing the file later changes nothing until the next
  // `task set`. `--opening ""` clears the exchange.
  let opening = current?.opening;
  if (named.has("opening")) {
    const value = named.get("opening") ?? "";
    opening =
      value === ""
        ? undefined
        : value.split(",").map((file) => {
            try {
              return readFileSync(file.trim(), "utf8");
            } catch (thrown) {
              return fail(`--opening ${file}: ${String(thrown)}`);
            }
          });
  }

  const paced = named.get("self-paced");
  if (paced !== undefined && paced !== "true" && paced !== "false") {
    fail("--self-paced must be true or false");
  }
  const selfPaced = paced === undefined ? current?.selfPaced : paced === "true";

  const drained = named.get("exit-when-drained");
  if (drained !== undefined && drained !== "true" && drained !== "false") {
    fail("--exit-when-drained must be true or false");
  }
  const exitWhenDrained = drained === undefined ? current?.exitWhenDrained : drained === "true";

  ledger.upsertTask({
    id,
    tiers,
    ...(share === undefined ? {} : { share }),
    demandCommand,
    demandConstant,
    gate: pick("gate", current?.gate),
    prompt: pick("prompt", current?.prompt),
    cwd: pick("cwd", current?.cwd),
    ...(exitWhenDrained === undefined ? {} : { exitWhenDrained }),
    doctrineUrl: pick("doctrine-url", current?.doctrineUrl),
    ...(opening === undefined ? {} : { opening }),
    openingProbe: pick("opening-probe", current?.openingProbe),
    ...(selfPaced === undefined ? {} : { selfPaced }),
    ...(current?.team === undefined ? {} : { team: current.team }),
  });
  console.log(`task ${id} ${current ? "updated" : "created"}`);
}

/**
 * Create one pending run for a lane right now, outside the controller's
 * allocation cycle. The normal path answers "is a launch worth an account's
 * quota" — demand, share, pacing — and an operator asking for a session has
 * already answered it. The broker still picks the account when it can; when
 * pacing refuses (`no-admission` is exactly the state this command exists
 * for), the tier's configured account list is walked directly and one
 * session is spent on operator authority. The run lands `pending`, so the
 * live runner claims it within a tick like any other.
 */
export function spawn(ledger: Ledger, args: string[], cfg = loadConfig()): void {
  const { positional, named } = flags(args);
  const taskId = positional[0] ?? fail("spawn <task-id> [--tier TIER] [--account ID] [--model ID]");
  const task = ledger.tasks().find((t) => t.id === taskId) ?? fail(`unknown task ${taskId}`);
  if (task.prompt === undefined) fail(`task ${taskId} is a pure demand signal; nothing to launch`);
  const tier = (named.get("tier") ?? task.tiers[0]?.tier ?? fail(`task ${taskId} has no tiers`)) as Tier;
  if (!TIERS.includes(tier)) fail(`unknown tier ${tier}`);
  const now = Date.now();
  const wanted = named.get("account");
  const wantedModel = named.get("model");
  const resolvedModel = wantedModel === undefined ? undefined : catalogModel(wantedModel)?.model ?? wantedModel;
  const candidates = (cfg.tiers[tier] ?? []).filter(
    (candidate) => resolvedModel === undefined || candidate.model === resolvedModel,
  );
  if (wantedModel !== undefined && candidates.length === 0) {
    fail(`tier ${tier} has no candidate matching model ${wantedModel}`);
  }
  let admission = wanted === undefined && wantedModel === undefined
    ? new Broker(ledger, brokerConfig(cfg)).admit(tier, now)
    : undefined;
  let forced = false;
  if (admission === undefined) {
    forced = true;
    const accounts = ledger
      .accounts()
      .filter((a) => a.fleetCredentialed && (a.cooldownUntil === undefined || a.cooldownUntil <= now));
    for (const candidate of candidates) {
      const account = accounts.find(
        (a) => a.provider === candidate.provider && (wanted === undefined || a.id === wanted),
      );
      if (account !== undefined) {
        admission = {
          accountId: account.id,
          provider: candidate.provider,
          model: candidate.model,
          ...(candidate.thinking === undefined ? {} : { thinking: candidate.thinking }),
        };
        break;
      }
    }
  }
  if (admission === undefined) {
    fail(
      wantedDetail(named.get("account")) +
        `no ${tier} account is even forceable: every candidate is uncredentialed or cooling down`,
    );
  }
  const runId = ledger.createRun({ taskId, tier, ...admission, at: now });
  console.log(
    `spawned ${runId}: ${taskId} (${tier}) on ${admission.accountId} → ${admission.provider}/${admission.model}` +
      (forced ? " [forced past pacing]" : ""),
  );
}

function wantedDetail(account: string | undefined): string {
  return account === undefined ? "" : `account ${account} unavailable; \u2014 `;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const ledger = Ledger.open(LEDGER_PATH);
  try {
    switch (command) {
      case "status":
        await status(ledger);
        break;
      case "capacity":
        capacity(ledger, args);
        break;
      case "usage":
        usage(ledger, args);
        break;
      case "pause":
      case "resume":
        launchControl(ledger, command, args);
        break;
      case "account":
        await accountCommand(ledger, args);
        break;
      case "boost":
        boostCommand(ledger, args);
        break;
      case "task": {
        const [sub, ...rest] = args;
        if (sub === "set") taskSet(ledger, rest);
        else if (sub === "list") {
          for (const t of ledger.tasks()) {
            const demand = t.demandCommand ?? `constant ${t.demandConstant}`;
            console.log(
              `${t.id}: tiers=${formatTiers(t.tiers)} share=${t.share ?? 1} demand=[${demand}]` +
                (t.gate !== undefined ? ` gate=[${t.gate}]` : "") +
                (t.exitWhenDrained ? " exit-when-drained" : "") +
                (t.opening !== undefined ? ` opening(${t.opening.length})` : "") +
                (t.openingProbe !== undefined ? " opening-probe" : "") +
                (t.selfPaced ? " self-paced" : "") +
                (t.team === undefined
                  ? ""
                  : ` team=${t.team.workers}+supervisor`) +
                (ledger.taskPaused(t.id) ? " HELD" : "") +
                (t.prompt === undefined ? " (signal only)" : ""),
            );
          }
        } else if (sub === "delete") {
          const id = rest[0] ?? fail("task delete <id>");
          ledger.deleteTask(id);
          console.log(`task ${id} deleted`);
        } else if (sub === "reconcile") {
          const path = rest[0] ?? fail("task reconcile <manifest.json>");
          if (rest.length !== 1) fail("task reconcile <manifest.json>");
          const result = reconcileTaskManifest(ledger, path);
          console.log(
            `reconciled ${result.upserted} task(s)` +
            (result.deleted.length === 0 ? "" : `; deleted ${result.deleted.join(", ")}`),
          );
        } else fail("usage: task set|list|delete|reconcile");
        break;
      }
      case "spawn":
        spawn(ledger, args);
        break;
      case "abort": {
        const runId = args[0] ?? fail("abort <runId>");
        const run = ledger.run(runId) ?? fail(`unknown run ${runId}`);
        if (run.state !== "running") fail(`run ${run.id} is ${run.state}; only a running session can abort`);
        ledger.requestAbort(run.id);
        console.log(`abort requested for ${run.id} (${run.taskId} on ${run.accountId})`);
        break;
      }
      // A session parked inside a provider call never returns, so `abort` — which
      // asks the agent loop to stop — can be ignored forever. This ends the run in
      // the ledger; the owning runner then tears the session down on its next tick.
      case "kill": {
        const runId = args[0] ?? fail("kill <runId> [reason]");
        const run = ledger.run(runId) ?? fail(`unknown run ${runId}`);
        if (run.state !== "running" && run.state !== "pending") {
          fail(`run ${run.id} is already ${run.state}`);
        }
        const reason = args.slice(1).join(" ") || "killed by operator";
        ledger.finishRun(run.id, { state: "aborted", detail: reason }, Date.now());
        ledger.taskFinished(run.taskId);
        console.log(`killed ${run.id} (${run.taskId} on ${run.accountId}): ${reason}`);
        break;
      }
      case "say":
        await say(ledger, args);
        break;
      case "daemon":
        await daemon(ledger, args);
        break;
      case "runner":
        await runner(ledger, args);
        break;
      case "supervisor":
        await supervisor(ledger, args);
        break;
      case "drain-runners":
        console.log(`runner generation is now ${bumpRunnerGeneration(ledger)}; live runners will drain`);
        break;
      case "voice-broker":
        await voiceBroker(ledger, args);
        break;
      default:
        console.log(
          [
            "usage: pi-orchestrator <command>",
            "  status                       tasks, gates, eligibility, running sessions",
            "  capacity [--provider F]      admission and quota facts as JSON, for external",
            "                               launchers sizing sessions on the pooled accounts",
            "  usage [--hours N]            where the token quota went: fleet vs interactive,",
            "                               by lane, account, model, and largest session",
            "  task set <id> --tiers light:20,standard [--share N] [--demand-command CMD | --demand-constant N]",
            "               [--gate EXPR] [--prompt TEXT] [--cwd DIR] [--exit-when-drained true|false]",
            "               [--doctrine-url URL]   pin a fetched document into the lane's system prompts",
            "               [--opening file1,file2] [--self-paced true|false] lived opening exchange",
            "               [--opening-probe CMD]  command whose JSON stdout fills {{key}} placeholders",
            "                                      in the opening messages, run fresh at every launch",
            "  task list | task delete <id> | task reconcile <manifest.json>",
            "  account list | account add <id> --provider F [--label L] [--shared true]",
            "  account remove <id>          drop an account that left this machine",

            "  account share <id> [on|off]  share a Codex account across both runtimes",
            "  account login <id>           device-login a Codex account into shared custody",
            "  pause | resume [task...]     durable launch control (ledger rows): the",
            "                               machine, or the named lanes",
            "  pause --except <task,...>    hold every other lane, so the fleet's whole",
            "                               capacity goes to the named ones",
            `  boost <family> [on|off|halt|N]  scale a family's spend pace (on = ${BOOSTED_MULTIPLIER}x,`,
            "                               halt = 0: no new launches for the family)",
            "  spawn <task-id> [--tier T] [--account ID] [--model ID]  create one pending run",
            "                               now, past demand and pacing when they refuse;",
            "                               --model pins one tier candidate by catalog id",
            "  abort <runId>                request a running session stop",
            "  kill <runId> [reason]        end a run its session will not stop for",
            "  say <runId> <text...>        deliver an operator message into a live",
            "                               session as a user turn",
            "  daemon [--interval MS]       controller loop (config: ~/.config/pi-orchestrator)",
            "  runner [--id NAME] [--max-sessions N] [--interval MS]",
            "                               host claimed runs as embedded pi sessions",
            "  supervisor [--id NAME] [--max-sessions N] [--interval MS]",
            "                               keep one worker of the live generation running",
            "  drain-runners                bump generation: the supervisor starts the",
            "                               successor at once, drained workers exit",
            "  voice-broker [--listen H:P]  GPT-Live SDP negotiation on the pooled accounts",
            "                               (default 127.0.0.1:2457; see src/voice/)",
          ].join("\n"),
        );
        if (command !== undefined && command !== "help") process.exit(1);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`pi-orchestrator: ${error.message}`);
    process.exitCode = 1;
  } finally {
    ledger.close();
  }
}

// Only when run as the CLI, so command implementations stay importable by
// tests. Compare real paths: this is invoked through a symlink on PATH, and a
// mismatch here makes every command silently do nothing and exit 0.
const invokedAs = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (invokedAs === import.meta.url) void main();
