import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, validateToolCall, type Context } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { catalogModel } from "../packages/orchestrator/src/catalog";
import { withCustomModels } from "../packages/orchestrator/src/models";
import { Store } from "../packages/orchestrator/src/store";
import { chooseInteractiveAccount } from "../packages/orchestrator/src/auth/account-selection";
import { defaultSharedAuthPath, providerOAuth, sharedOAuthProvider } from "../packages/orchestrator/src/auth/shared-oauth";
import type { MemoryClient, MemoryRequest } from "../packages/kenan-memory/src/contract";
import { memoryExtension } from "../packages/kenan-memory/src/tools";

export interface DiscretionTurn {
  model: string;
  question: string;
  answer: string;
  operations: Array<{ request: MemoryRequest; response: unknown }>;
}

/** Only synthetic prompts go to owner-held providers. No AGENTS, account secrets or personal context enter fixture state. */
export async function discretionTurn(options: {
  person: string; threadId: string; question: string; policy: string; hostFile: string; memory: MemoryClient;
  model: "sol" | "opus"; timeoutMs?: number;
}): Promise<DiscretionTurn> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const operations: DiscretionTurn["operations"] = [];
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const memory: MemoryClient = { async request(request) {
    const response = await options.memory.request(request);
    operations.push({ request, response });
    return response as any;
  } };
  memoryExtension({ env: { PI_STACK_HOST_CONFIG: options.hostFile, PI_KENAN_MEMORY_PERSON: options.person, PI_THREAD_ID: options.threadId },
    client: memory, ask: async () => { throw new Error("This fixture has not answered a forget clarification"); },
  })({ registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, handler: Function) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  } } as any);
  const specification = catalogModel(options.model)!;
  const ledger = process.env.PI_ORCHESTRATOR_LEDGER ?? join(homedir(), ".local/share/pi-orchestrator/ledger.sqlite3");
  const store = Store.open(ledger);
  const lease = `one-kenan-fixture:${randomUUID()}`;
  try {
    const family = withCustomModels(builtinProviders().find(provider => provider.id === specification.provider)!);
    const auth = providerOAuth(family, defaultSharedAuthPath(ledger));
    const account = chooseInteractiveAccount(store, auth, family.id, new Set(), { model: specification.model });
    if (!account) throw new Error(`No eligible pooled ${options.model} account for synthetic acceptance`);
    const models = createModels();
    models.setProvider(sharedOAuthProvider(family, account.id, account.label, auth));
    const model = models.getModel(account.id, specification.model)!;
    if (!model) throw new Error(`Missing fixture model ${specification.model}`);
    store.createLease(lease, account.id, "interactive");
    const context: Context = { systemPrompt: `${options.policy}\n\nYou are talking privately to ${options.person}. Registered household persons are alice and bob.`,
      tools: [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
      messages: [{ role: "user", content: options.question, timestamp: Date.now() }],
    };
    for (const handler of handlers.get("turn_start") ?? []) await handler({}, {});
    for (let step = 0; step < 10; step++) {
      const message = await models.completeSimple(model, context, { reasoning: "low", signal, sessionId: lease });
      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      for (const component of ["input", "output", "cacheRead", "cacheWrite"] as const)
        if (message.usage[component] > 0) store.recordUsage({ accountId: account.id, hour, source: "interactive", runId: lease, model: model.id, component, tokens: message.usage[component] });
      if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`Fixture provider failed: ${message.errorMessage}`);
      context.messages.push(message);
      for (const handler of handlers.get("message_end") ?? []) await handler({ message }, {});
      const calls = message.content.filter(block => block.type === "toolCall");
      if (!calls.length) {
        const answer = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        for (const handler of handlers.get("agent_settled") ?? []) await handler({ messages: context.messages }, {});
        return { model: options.model, question: options.question, answer, operations };
      }
      for (const call of calls) {
        const input = validateToolCall(context.tools!, call);
        const tool = tools.get(call.name);
        const result = await tool.execute(call.id, input, signal);
        context.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, details: result.details, isError: result.isError, timestamp: Date.now() });
      }
    }
    throw new Error("Fixture model exceeded ten memory/answer steps");
  } finally {
    store.endLease(lease);
    store.close();
  }
}
