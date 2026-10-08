#!/usr/bin/env node
import { dispatch } from "./commands.js";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runnerSocketDirectory } from "./threads/runner-transport.js";
import { startFleetHistory, NativeHistoryStartupError } from "./native-history-startup.js";

const args = process.argv.slice(2);
const operation = args[0] === "agent-capacity"
  ? import("./agent-capacity-census.js").then(({ agentCapacityCommand }) => agentCapacityCommand(args.slice(1)))
  : args[0] === "model-broker"
  ? import("./model-broker.js").then(({ runModelBroker }) => {
    if (args.length !== 2) throw new Error("Usage: pi-orchestrator model-broker /etc/pi-model-broker.json");
    return runModelBroker(args[1]);
  })
  : (async () => {
    if (args[0] === "daemon") {
      const ledgerPath = process.env.PI_ORCHESTRATOR_LEDGER ?? join(homedir(), ".local/share/pi-orchestrator/ledger.sqlite3");
      const state = await startFleetHistory({ ledgerPath, socketDir: runnerSocketDirectory(dirname(ledgerPath)), releaseRoot: dirname(dirname(fileURLToPath(import.meta.url))) });
      if (state === "maintenance") return;
    }
    return dispatch(args);
  })();
operation.catch((error)=>{
  console.error(error instanceof Error?error.message:String(error));
  process.exitCode=error instanceof NativeHistoryStartupError ? error.exitCode : 1;
});
