#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Broker } from "./broker/broker.js";
import { Controller } from "./controller/controller.js";
import { Ledger } from "./ledger/ledger.js";
import { Runner, bumpRunnerGeneration } from "./host/runner.js";
import { Scheduler } from "./tasks/scheduler.js";
import { TIERS, type Tier } from "./tasks/types.js";
import type { AccountDomain } from "./ledger/ledger.js";
import { brokerConfig, defaultConfigPath, loadConfig } from "./config.js";
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

function fail(message: string): never {
  console.error(`pi-orchestrator: ${message}`);
  process.exit(1);
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
  if (evaluation.tasks.length === 0) console.log("no tasks");
}

/** Models served by pi extension providers (cursor) are not in the builtin
 * catalog; build a minimal Model from the extension's cached discovery. The
 * embedded session's own extension runtime registers the provider and owns
 * streaming; this object only names the model. */
function extensionModel(provider: string, modelId: string): Record<string, unknown> | undefined {
  if (provider !== "cursor") return undefined;
  try {
    const raw = readFileSync(join(homedir(), ".cache", "pi-cursor", "model-catalog.json"), "utf8");
    const entry = (JSON.parse(raw).rawModels as { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }[])
      .find((m) => m.id === modelId);
    if (entry === undefined) return undefined;
    return {
      id: entry.id,
      provider: "cursor",
      name: entry.name ?? entry.id,
      api: "openai-completions",
      baseUrl: "",
      reasoning: entry.reasoning ?? false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow ?? 200_000,
      maxTokens: entry.maxTokens ?? 32_000,
    };
  } catch {
    return undefined;
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
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const families = new Map(builtinProviders().map((p) => [p.id, p]));
  const resolveModel = (spec: LaunchSpec): unknown => {
    const model =
      families.get(spec.provider)?.getModels().find((m) => m.id === spec.model) ??
      extensionModel(spec.provider, spec.model);
    if (model === undefined) throw new Error(`unknown model ${spec.provider}/${spec.model}`);
    return spec.accountId === spec.provider ? model : { ...model, provider: spec.accountId };
  };
  const runnerId = named.get("id") ?? `${hostname()}-${process.pid}`;
  const engine: InstanceType<typeof PiHost> = new PiHost(
    // The runner is constructed below; PiHost only needs the event surface.
    { runFinished: (id, result, at) => live.runFinished(id, result, at),
      heartbeat: (id, at) => live.heartbeat(id, at) },
    { resolveModel },
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
  } else fail("usage: account list | account add <id> --provider F [--label L] [--domain D] | account domain <id> <domain>");
}

function taskSet(ledger: Ledger, args: string[]): void {
  const { positional, named } = flags(args);
  const id = positional[0] ?? fail("task set <id> --tiers ... required");
  const tiers = (named.get("tiers") ?? fail("--tiers required")).split(",") as Tier[];
  for (const t of tiers) if (!TIERS.includes(t)) fail(`unknown tier ${t}`);
  const demandConstant = named.has("demand-constant")
    ? Number(named.get("demand-constant"))
    : undefined;
  ledger.upsertTask({
    id,
    tiers,
    demandCommand: named.get("demand-command"),
    demandConstant,
    gate: named.get("gate"),
    prompt: named.get("prompt"),
    cwd: named.get("cwd"),
  });
  console.log(`task ${id} saved`);
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
      default:
        console.log(
          [
            "usage: pi-orchestrator <command>",
            "  status                       tasks, gates, eligibility, running sessions",
            "  task set <id> --tiers light,standard [--demand-command CMD | --demand-constant N]",
            "               [--gate EXPR] [--prompt TEXT] [--cwd DIR]",
            "  task list | task delete <id>",
            "  account list | account add <id> --provider F [--label L] [--domain D]",
            "  account domain <id> interactive|orchestrator",
            "                               credential-custody domain (see README)",
            "  pause | resume               durable launch control (a ledger row)",
            "  abort <runId>                request a running session stop",
            "  daemon [--interval MS]       controller loop (config: ~/.config/pi-orchestrator)",
            "  runner [--id NAME] [--max-sessions N] [--interval MS]",
            "                               host claimed runs as embedded pi sessions",
            "  drain-runners                bump generation: runners finish and exit",
          ].join("\n"),
        );
        if (command !== undefined && command !== "help") process.exit(1);
    }
  } finally {
    ledger.close();
  }
}

void main();
