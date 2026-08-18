import { randomUUID } from "node:crypto";
import {
  classifyError,
  contextMetrics,
  fingerprint,
  sharedUsageDatabase,
} from "./database.mjs";

function defaultOwner() {
  if (process.env.PI_USAGE_OWNER_KIND) {
    return {
      kind: process.env.PI_USAGE_OWNER_KIND,
      id: process.env.PI_USAGE_OWNER_ID,
      label: process.env.PI_USAGE_OWNER_LABEL,
    };
  }
  if (process.env.PI_REMOTE_SESSION_ID) {
    return { kind: "pi-remote", id: process.env.PI_REMOTE_SESSION_ID };
  }
  if (process.argv.some((item) => item.endsWith("/orchestrator.mjs"))) return null;
  return { kind: process.env.PROMPT_EVAL_SYSTEM_PROMPT ? "prompt-eval" : "interactive" };
}

function payloadSections(payload) {
  const value = payload && typeof payload === "object" ? payload : {};
  const whole = fingerprint(value);
  const system = fingerprint(value.system ?? value.instructions ?? null);
  const messages = fingerprint(value.messages ?? value.input ?? []);
  const tools = fingerprint(value.tools ?? []);
  return {
    payloadBytes: whole.bytes,
    payloadHash: whole.hash,
    payloadSystemBytes: system.bytes,
    payloadSystemHash: system.hash,
    payloadMessagesBytes: messages.bytes,
    payloadMessagesHash: messages.hash,
    payloadToolsBytes: tools.bytes,
    payloadToolsHash: tools.hash,
    serviceTier: typeof value.service_tier === "string" ? value.service_tier : null,
  };
}

function textBytes(content) {
  if (typeof content === "string") return Buffer.byteLength(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => total + (block && typeof block === "object" && typeof block.text === "string" ? Buffer.byteLength(block.text) : 0),0);
}

export function createUsageLogger(options = {}) {
  return function usageLogger(pi) {
    if (process.env.PI_USAGE_DISABLE === "1") return;
    const owner = options.owner ?? defaultOwner();
    if (!owner) return;
    const store = options.store ?? sharedUsageDatabase(options.dbPath);
    let lastWarning = 0;
    let sessionId;
    let mode = "unknown";
    let currentRun;
    let currentTurn;
    let sequence = 0;
    let system = { bytes: 0, hash: null };
    let toolSchema = { bytes: 0, hash: null };
    let context = contextMetrics([]);
    const pendingRequests = [];
    const tools = new Map();

    const safe = (operation) => {
      try { return operation(); }
      catch (error) {
        const at = Date.now();
        if (at - lastWarning > 60_000) {
          lastWarning = at;
          console.error(`[pi-usage] logging failure (${classifyError(error?.message).category}, ${classifyError(error?.message).hash})`);
        }
        return undefined;
      }
    };

    const touchSession = (ctx, at = Date.now()) => {
      sessionId = ctx.sessionManager.getSessionId();
      mode = ctx.mode;
      safe(() => store.upsertSession({
        sessionId,
        at,
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        mode,
        ownerKind: owner.kind,
        ownerId: owner.id ?? sessionId,
        ownerLabel: owner.label,
        remoteSessionId: process.env.PI_REMOTE_SESSION_ID,
        orchestratorRunId: owner.kind === "orchestrator" ? owner.id : undefined,
      }));
    };

    pi.on("session_start", (event, ctx) => {
      touchSession(ctx);
      safe(() => store.insertLifecycle({ sessionId, at: Date.now(), kind: `session_${event.reason}` }));
    });

    pi.on("session_shutdown", (event, ctx) => {
      touchSession(ctx);
      safe(() => store.insertLifecycle({ sessionId,runId:currentRun,at:Date.now(),kind:`session_shutdown_${event.reason}` }));
    });

    pi.on("before_agent_start", (event, ctx) => {
      touchSession(ctx);
      system = fingerprint(event.systemPrompt ?? "");
      const active = new Set(pi.getActiveTools());
      const definitions = pi.getAllTools().filter((tool) => active.has(tool.name)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines,
      }));
      toolSchema = fingerprint(definitions);
    });

    pi.on("agent_start", (_event, ctx) => {
      touchSession(ctx);
      currentRun = randomUUID();
      safe(() => store.insertAgentRun({
        runId: currentRun,
        sessionId,
        at: Date.now(),
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinking: ctx.thinkingLevel,
      }));
    });

    pi.on("agent_end", () => {
      if (currentRun) safe(() => store.endAgentRun(currentRun,Date.now(),false));
    });

    pi.on("agent_settled", () => {
      if (currentRun) safe(() => store.endAgentRun(currentRun,Date.now(),true));
      currentRun = undefined;
      currentTurn = undefined;
    });

    pi.on("turn_start", (event, ctx) => {
      touchSession(ctx);
      currentTurn = randomUUID();
      safe(() => store.insertTurn({ turnId:currentTurn,sessionId,runId:currentRun,turnIndex:event.turnIndex,at:event.timestamp ?? Date.now() }));
    });

    pi.on("turn_end", (event) => {
      if (currentTurn) safe(() => store.endTurn(currentTurn,Date.now(),Array.isArray(event.toolResults) ? event.toolResults.length : 0));
    });

    pi.on("context", (event) => {
      context = contextMetrics(event.messages);
    });

    pi.on("before_provider_request", (event, ctx) => {
      touchSession(ctx);
      sequence = safe(() => store.nextRequestSequence(sessionId)) ?? sequence + 1;
      const requestId = randomUUID();
      const payload = payloadSections(event.payload);
      safe(() => store.insertRequest({
        requestId,
        sessionId,
        runId: currentRun,
        turnId: currentTurn,
        sequence,
        at: Date.now(),
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        api: ctx.model?.api,
        thinking: ctx.thinkingLevel,
        systemPromptBytes: system.bytes,
        systemPromptHash: system.hash,
        toolSchemaBytes: toolSchema.bytes,
        toolSchemaHash: toolSchema.hash,
        contextMessages: context.messageCount,
        contextBytes: context.bytes,
        contextHash: context.hash,
        contextUserBytes: context.userBytes,
        contextAssistantBytes: context.assistantBytes,
        contextThinkingBytes: context.thinkingBytes,
        contextToolResultBytes: context.toolResultBytes,
        contextImageCount: context.imageCount,
        contextToolCalls: context.toolCalls,
        ...payload,
      }));
      pendingRequests.push({ requestId,sequence,provider:ctx.model?.provider,model:ctx.model?.id,response:false,finished:false });
    });

    pi.on("after_provider_response", (event) => {
      const request = pendingRequests.find((item) => !item.finished);
      if (!request) return;
      request.response = true;
      safe(() => store.recordResponse(request.requestId,Date.now(),event.status,event.headers));
    });

    pi.on("message_start", (event) => {
      if (event.message?.role !== "assistant") return;
      const request = pendingRequests.find((item) => !item.finished);
      if (request) safe(() => store.markStreamStart(request.requestId,Date.now()));
    });

    pi.on("message_end", (event, ctx) => {
      touchSession(ctx);
      if (event.message.role === "assistant") {
        let request = pendingRequests.find((item) => !item.finished);
        if (!request) {
          sequence = safe(() => store.nextRequestSequence(sessionId)) ?? sequence + 1;
          request = { requestId:randomUUID(),sequence,provider:event.message.provider,model:event.message.model,response:false,finished:false };
          safe(() => store.insertRequest({
            requestId:request.requestId,sessionId,runId:currentRun,turnId:currentTurn,sequence,at:event.message.timestamp ?? Date.now(),
            provider:event.message.provider,model:event.message.model,api:event.message.api,thinking:ctx.thinkingLevel,
            systemPromptBytes:system.bytes,systemPromptHash:system.hash,toolSchemaBytes:toolSchema.bytes,toolSchemaHash:toolSchema.hash,
            contextMessages:context.messageCount,contextBytes:context.bytes,contextHash:context.hash,contextUserBytes:context.userBytes,
            contextAssistantBytes:context.assistantBytes,contextThinkingBytes:context.thinkingBytes,contextToolResultBytes:context.toolResultBytes,
            contextImageCount:context.imageCount,contextToolCalls:context.toolCalls,...payloadSections({}),
          }));
          pendingRequests.push(request);
        }
        request.finished = true;
        const previous = safe(() => store.previousRequest(sessionId,request.sequence,request.provider,request.model));
        safe(() => store.finishRequest(request.requestId,Date.now(),event.message,previous));
        if (event.message.stopReason === "error") {
          if (currentRun) safe(() => store.incrementRetry(currentRun));
          const detail = classifyError(event.message.errorMessage);
          safe(() => store.insertLifecycle({ sessionId,runId:currentRun,at:Date.now(),kind:"assistant_error",detailCategory:detail.category,detailHash:detail.hash }));
        }
        while (pendingRequests[0]?.finished) pendingRequests.shift();
      } else if (event.message.role === "toolResult" && event.message.usage) {
        safe(() => store.insertUsageEvent({ sessionId,runId:currentRun,at:Date.now(),kind:"tool_nested",reason:event.message.toolName,success:!event.message.isError,usage:event.message.usage }));
      }
    });

    pi.on("tool_execution_start", (event, ctx) => {
      touchSession(ctx);
      const id = randomUUID();
      const args = fingerprint(event.args ?? {});
      tools.set(event.toolCallId,id);
      safe(() => store.insertTool({ id,sessionId,runId:currentRun,turnId:currentTurn,toolCallId:event.toolCallId,toolName:event.toolName,at:Date.now(),argsBytes:args.bytes,argsHash:args.hash }));
    });

    pi.on("tool_execution_end", (event) => {
      const id = tools.get(event.toolCallId);
      if (!id) return;
      tools.delete(event.toolCallId);
      const result = fingerprint(event.result ?? {});
      safe(() => store.finishTool(id,Date.now(),event.isError,result.bytes,result.hash));
    });

    pi.on("session_before_compact", (event) => {
      safe(() => store.insertLifecycle({
        sessionId,runId:currentRun,at:Date.now(),kind:"compaction_start",success:undefined,
        detailCategory:event.willRetry ? "retry" : event.reason,
      }));
    });

    pi.on("session_compact", (event) => {
      const detail = fingerprint(event.compactionEntry?.summary ?? "");
      safe(() => store.insertUsageEvent({
        sessionId,runId:currentRun,at:Date.now(),kind:"compaction",reason:event.reason,success:true,
        usage:event.compactionEntry?.usage,tokensBefore:event.compactionEntry?.tokensBefore,
        detailBytes:detail.bytes,detailHash:detail.hash,
      }));
    });

    pi.on("session_tree", (event) => {
      if (!event.summaryEntry?.usage) return;
      const detail = fingerprint(event.summaryEntry?.summary ?? "");
      safe(() => store.insertUsageEvent({
        sessionId,runId:currentRun,at:Date.now(),kind:"tree_summary",success:true,
        usage:event.summaryEntry.usage,detailBytes:detail.bytes,detailHash:detail.hash,
      }));
    });

    pi.on("model_select", (event, ctx) => {
      touchSession(ctx);
      safe(() => store.insertLifecycle({ sessionId,runId:currentRun,at:Date.now(),kind:`model_${event.source}` }));
    });
  };
}

export default createUsageLogger();

export const _test = { defaultOwner, payloadSections, textBytes };
