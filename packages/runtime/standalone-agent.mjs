import { existsSync } from "node:fs";

// Installed doctors have a closed, Node-only copy beside them. Source/tools use
// the owning orchestrator package; neither route relies on extension loading.
const installed = new URL("./capacity/standalone-agent.js", import.meta.url);
const entry = process.env.PI_STACK_STANDALONE_AGENT_MODULE ?? (existsSync(installed) ? installed.href : "pi-orchestrator/standalone-agent");
const guard = await import(entry);
export const { requireStandaloneAgent, settleStandaloneAgent, abortAndSettleStandaloneSession, standaloneRecordPath } = guard;
