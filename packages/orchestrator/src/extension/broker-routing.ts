import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupSessionResources, type Provider } from "@earendil-works/pi-ai";
import { brokerProvider, BROKER_ROUTES } from "../model-broker-contract.js";
import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import { installImageGeneration } from "./image-generation.js";
import { Store } from "../store.js";

export function installBrokerRouting(pi: ExtensionAPI, url: string, families: Provider[], ledgerPath: string, env: NodeJS.ProcessEnv): void {
  const providers = families.filter(family => family.id in BROKER_ROUTES).map(family => brokerProvider(family, url));
  for (const provider of providers) pi.registerProvider(provider);
  const store = Store.open(ledgerPath);
  installImageGeneration(pi, store, undefined, url);
  pi.on("session_shutdown", (_event, ctx) => { cleanupSessionResources(ctx.sessionManager.getSessionId()); store.close(); });
  const requestedPin = env.PI_SUBAGENT_MODEL;
  const pin = ORCHESTRATOR_CATALOG.models.find(model => model.id === requestedPin || model.model === requestedPin);
  const select = async (ctx: ExtensionContext) => {
    const selected = ctx.model;
    if (!selected && !pin) return;
    const family = pin?.provider ?? selected!.provider.replace(/-\d+$/u, "");
    if (!pin && !(family in BROKER_ROUTES)) return;
    const id = pin?.model ?? selected!.id;
    const model = providers.find(provider => provider.id === family)?.getModels().find(model => model.id === id);
    if (!model) throw new Error(`Model ${family}/${id} is not available through the model broker`);
    if (selected?.provider === model.provider && selected.id === model.id) return;
    const thinking = pi.getThinkingLevel();
    if (!await pi.setModel(model)) throw new Error(`Cannot select broker model ${family}/${id}`);
    pi.setThinkingLevel(thinking);
  };
  pi.on("session_start", async (_event, ctx) => select(ctx));
  if (requestedPin) {
    pi.on("before_agent_start", async (_event, ctx) => {
      if (!pin) throw new Error(`Unknown subagent model pin ${requestedPin}`);
      await select(ctx);
    });
    pi.on("before_provider_request", (_event, ctx) => {
      if (!pin || ctx.model?.provider !== pin.provider || ctx.model.id !== pin.model) throw new Error(`This agent is pinned to ${requestedPin}`);
    });
  }
}
