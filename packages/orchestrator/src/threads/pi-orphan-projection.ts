import type { Agent } from "@earendil-works/pi-agent-core";
import { projectOrphanToolResults } from "./orphan-tool-results.mjs";
const installed = new WeakMap<Agent, Agent["transformContext"]>();
export function installOrphanReceiptProjection(agent: Agent): void {
  if (installed.has(agent) && installed.get(agent) === agent.transformContext) return;
  const original = agent.transformContext;
  const wrapper: Agent["transformContext"] = async (messages, signal) => projectOrphanToolResults(original ? await original.call(agent, messages, signal) : messages);
  agent.transformContext = wrapper;
  installed.set(agent, wrapper);
}
