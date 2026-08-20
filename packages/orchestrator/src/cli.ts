#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Broker } from "./broker/broker.js";
import { Controller } from "./controller/controller.js";
import { Ledger } from "./ledger/ledger.js";
import { Runner, bumpRunnerGeneration } from "./host/runner.js";
import { Scheduler } from "./tasks/scheduler.js";
import { TIERS, type Tier } from "./tasks/types.js";
import type { AccountDomain } from "./ledger/ledger.js";
import { brokerConfig, defaultConfigPath, loadConfig } from "./config.js";
import { VoiceBroker } from "./voice/broker.js";
import { createVoiceServer } from "./voice/server.js";
import type { LaunchSpec } from "./host/types.js";

/**
 * Operator CLI. Thin by design: every command is a small read or write
 * against the ledger plus a scheduler evaluation; all policy lives in the
 * library modules. The daemon command additionally needs broker + host
 * configuration, which is deliberately not wired here yet — see README
 * (deployment configuration is the next roadmap step).
 */

const LEDGER_PATH =
  process.env.PI_ORCHESTRATOR_LEDGER ??
  join(homedir(), ".local", "share", "pi-orchestrator", "ledger.sqlite3");

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

async function status(ledger: Ledger): Promise<void> {
  console.log(`ledger: ${LEDGER_PATH}`);
  console.log(`launches: ${ledger.getControl("launches") ?? "enabled"}`);
  for (const b of ledger.boosts()) console.log(`boost ${b.provider}: ${b.multiplier}x allowance`);
  const evaluation = await new Scheduler(ledger).evaluate();
  for (const t of evaluation.tasks) {
    const parts = [
      t.eligible ? "eligible" : "waiting",
      `units=${t.units ?? "?"}`,
      `gate=${t.gateOpen ? "open" : "closed"}`,
      `tiers=${t.tiers.join(",")}`,
    ];
    if (t.error !== undefined) parts.push(`error=${t.error}`);
    console.log(`task ${t.taskId}: ${parts.join(" ")}`);
  }
  for (const r of ledger.runs({ state: "pending" })) {
    console.log(`pending ${r.id.slice(0, 8)}: ${r.taskId} awaiting runner`);
  }
  for (const r of ledger.runs({ state: "running" })) {
    console.log(
      `run ${r.id.slice(0, 8)}: ${r.taskId} on ${r.accountId} (${r.model}) runner=${r.runnerId}`,
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

/** Controller daemon: the launch loop. Tier→model maps and meter topology
 * come from operator config; everything else is measured. */
async function daemon(ledger: Ledger, args: string[]): Promise<void> {
  const { named } = flags(args);
  const cfg = loadConfig();
  const controller = new Controller(
    ledger,
    new Scheduler(ledger),
    new Broker(ledger, brokerConfig(cfg)),
  );
  const intervalMs = Number(named.get("interval") ?? 30_000);
  console.log(`controller started (config: ${defaultConfigPath()})`);
  for (;;) {
    try {
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
  const { named } = flags(args);
  const listen = named.get("listen") ?? "127.0.0.1:2457";
  const separator = listen.lastIndexOf(":");
  const host = separator > 0 ? listen.slice(0, separator) : "127.0.0.1";
  const port = Number(listen.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`voice-broker: invalid --listen ${listen}`);
  const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const broker = new VoiceBroker({ agentDir, accounts: () => ledger.accounts() });
  const server = createVoiceServer(broker);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const initial = broker.status();
  console.log(`voice broker listening on ${host}:${port} (${initial.accountCount} eligible accounts, agentDir ${agentDir})`);
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
  const { named } = flags(args);
  // Hosted sessions must never be re-routed by the interactive routing
  // extension: the broker assigned their account.
  process.env.PI_ORCHESTRATOR_ASSIGNED = "1";
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
      heartbeat: (id, at) => live.heartbeat(id, at) },
    { resolveModel, runsRoot },
  );
  const live = new Runner(ledger, engine, {
    runnerId,
    maxSessions: Number(named.get("max-sessions") ?? 100),
  });
  const intervalMs = Number(named.get("interval") ?? 5000);
  console.log(`runner ${runnerId} started`);
  for (;;) {
    const report = live.tick();
    for (const spec of report.claimed) console.log(`claimed ${spec.runId}: ${spec.taskId}`);
    if (live.drained()) {
      console.log(`runner ${runnerId} drained, exiting`);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const DOMAINS: readonly AccountDomain[] = ["interactive", "orchestrator"];

function accountCommand(ledger: Ledger, args: string[]): void {
  const [sub, ...rest] = args;
  if (sub === "list") {
    for (const a of ledger.accounts()) {
      const parts = [`provider=${a.provider}`, `domain=${a.domain}`];
      if (a.label !== undefined) parts.push(`label=${a.label}`);
      if (a.accessUntil !== undefined) parts.push(`access_until=${new Date(a.accessUntil).toISOString()}`);
      if (a.cooldownUntil !== undefined && a.cooldownUntil > Date.now())
        parts.push(`cooling_until=${new Date(a.cooldownUntil).toISOString()}`);
      console.log(`${a.id}: ${parts.join(" ")}`);
    }
  } else if (sub === "add") {
    const { positional, named } = flags(rest);
    const id = positional[0] ?? fail("account add <id> --provider FAMILY required");
    const provider = named.get("provider") ?? fail("--provider required");
    const domain = named.get("domain") as AccountDomain | undefined;
    if (domain !== undefined && !DOMAINS.includes(domain)) fail(`unknown domain ${domain}`);
    ledger.upsertAccount({ id, provider, label: named.get("label"), domain });
    console.log(`account ${id} saved`);
  } else if (sub === "remove") {
    const id = rest[0] ?? fail("usage: account remove <id>");
    const removed = ledger.removeAccount(id);
    console.log(
      `account ${id} removed with ${removed.usageEvents} usage events and ` +
        `${removed.meterReadings} meter readings. Delete its auth.json entry here too — ` +
        "an account's credential lives on exactly one machine.",
    );
  } else if (sub === "domain") {
    const [id, domain] = rest;
    if (id === undefined || !DOMAINS.includes(domain as AccountDomain))
      fail("usage: account domain <id> interactive|orchestrator");
    ledger.setAccountDomain(id, domain as AccountDomain);
    console.log(
      `account ${id} custody is now ${domain}. Move its auth.json credential to the ` +
        `${domain === "orchestrator" ? "orchestrator user's" : "interactive user's"} agent dir — ` +
        "refresh tokens rotate, so exactly one copy may exist.",
    );
  } else
    fail(
      "usage: account list | account add <id> --provider F [--label L] [--domain D] | " +
        "account remove <id> | account domain <id> <domain>",
    );
}

/** The 5× the Pi Remote drawer controls: one deliberate, durable multiplier
 * on a family's paced spend, honoured by every broker decision. */
const DEFAULT_BOOST = 5;

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
    value === "on" ? DEFAULT_BOOST : value === "off" ? 1 : Number(value);
  if (!Number.isFinite(multiplier) || multiplier < 1) fail("usage: boost <family> [on|off|N>=1]");
  ledger.setBoost(family, multiplier);
  console.log(`${family}: ${multiplier}x allowance`);
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
    (named.get("tiers")?.split(",") as Tier[] | undefined) ??
    current?.tiers ??
    fail(`--tiers required: ${id} does not exist yet`);
  for (const t of tiers) if (!TIERS.includes(t)) fail(`unknown tier ${t}`);

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

  ledger.upsertTask({
    id,
    tiers,
    demandCommand,
    demandConstant,
    gate: pick("gate", current?.gate),
    prompt: pick("prompt", current?.prompt),
    cwd: pick("cwd", current?.cwd),
  });
  console.log(`task ${id} ${current ? "updated" : "created"}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const ledger = Ledger.open(LEDGER_PATH);
  try {
    switch (command) {
      case "status":
        await status(ledger);
        break;
      case "pause":
        ledger.setControl("launches", "paused");
        console.log("launches paused (running agents unaffected)");
        break;
      case "resume":
        ledger.setControl("launches", "enabled");
        console.log("launches enabled");
        break;
      case "account":
        accountCommand(ledger, args);
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
              `${t.id}: tiers=${t.tiers.join(",")} demand=[${demand}]` +
                (t.gate !== undefined ? ` gate=[${t.gate}]` : "") +
                (t.prompt === undefined ? " (signal only)" : ""),
            );
          }
        } else if (sub === "delete") {
          const id = rest[0] ?? fail("task delete <id>");
          ledger.deleteTask(id);
          console.log(`task ${id} deleted`);
        } else fail("usage: task set|list|delete");
        break;
      }
      case "abort": {
        const runId = args[0] ?? fail("abort <runId>");
        ledger.requestAbort(runId);
        console.log(`abort requested for ${runId}`);
        break;
      }
      case "daemon":
        await daemon(ledger, args);
        break;
      case "runner":
        await runner(ledger, args);
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
            "  task set <id> --tiers light,standard [--demand-command CMD | --demand-constant N]",
            "               [--gate EXPR] [--prompt TEXT] [--cwd DIR]",
            "  task list | task delete <id>",
            "  account list | account add <id> --provider F [--label L] [--domain D]",
            "  account remove <id>          drop an account that left this machine",
            "  account domain <id> interactive|orchestrator",
            "                               credential-custody domain (see README)",
            "  pause | resume               durable launch control (a ledger row)",
            `  boost <family> [on|off|N]    scale a family's spend pace (on = ${DEFAULT_BOOST}x)`,
            "  abort <runId>                request a running session stop",
            "  daemon [--interval MS]       controller loop (config: ~/.config/pi-orchestrator)",
            "  runner [--id NAME] [--max-sessions N] [--interval MS]",
            "                               host claimed runs as embedded pi sessions",
            "  drain-runners                bump generation: runners finish and exit",
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
