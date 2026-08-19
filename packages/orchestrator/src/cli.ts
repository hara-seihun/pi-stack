#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger/ledger.js";
import { Scheduler } from "./tasks/scheduler.js";
import { TIERS, type Tier } from "./tasks/types.js";

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
  const running = ledger.runs({ state: "running" });
  for (const r of running) {
    console.log(`run ${r.id.slice(0, 8)}: ${r.taskId} on ${r.accountId} (${r.model})`);
  }
  if (evaluation.tasks.length === 0) console.log("no tasks");
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
      default:
        console.log(
          [
            "usage: pi-orchestrator <command>",
            "  status                       tasks, gates, eligibility, running sessions",
            "  task set <id> --tiers light,standard [--demand-command CMD | --demand-constant N]",
            "               [--gate EXPR] [--prompt TEXT] [--cwd DIR]",
            "  task list | task delete <id>",
            "  pause | resume               durable launch control (a ledger row)",
            "  abort <runId>                request a running session stop",
          ].join("\n"),
        );
        if (command !== undefined && command !== "help") process.exit(1);
    }
  } finally {
    ledger.close();
  }
}

void main();
