import { randomUUID } from "node:crypto";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  KIND, VERSION, compactionObserver, compactionPayload,
  failure, featureHeader, findCheckpoint, isCodex, modelKey, replaceMarker,
  retainRecentUsers, success,
} from "./native.mjs";

const OPERATION_EVENT = "pi-stack:provider-operation";
const markerFor = checkpoint => `Pi Codex checkpoint ${checkpoint.entry.id}`;

/** Only the model and API determine whether a checkpoint can be replayed. */
export function checkpointContext(messages, branch, model) {
  const lookup = findCheckpoint(branch);
  if (!lookup.ok) return lookup;
  const checkpoint = lookup.value;
  if (!checkpoint || !isCodex(model) || checkpoint.details.modelKey !== modelKey(model)) return success({ messages });
  const index = messages.findIndex(message => message.role === "compactionSummary" && message.summary === checkpoint.entry.summary);
  if (index < 0) return failure("The active Codex checkpoint summary is missing from Pi context");
  const saved = buildSessionContext(branch.slice(0, checkpoint.index + 1)).messages;
  const kept = saved.slice(1);
  for (let offset = 0; offset < kept.length; offset++) {
    const actual = messages[index + 1 + offset], expected = kept[offset];
    if (!actual || actual.role !== expected.role || actual.timestamp !== expected.timestamp) return failure("An extension changed the Codex checkpoint's retained message boundary");
  }
  const marker = markerFor(checkpoint);
  return success({
    messages: [...messages.slice(0, index), { role: "user", content: marker, timestamp: messages[index].timestamp }, ...messages.slice(index + kept.length + 1)],
    checkpoint,
    marker,
  });
}

export async function providerOperation(pi, ctx, model, signal, run) {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const request = { model, signal, sessionId: ctx.sessionManager.getSessionId(), purpose: "compaction", run, handled: false, resolve };
  pi.events.emit(OPERATION_EVENT, request);
  if (request.handled) return pending;
  try { return await run(model); } catch (error) { return failure(error); }
}

export async function createCheckpoint(pi, ctx, event, fetchImpl = globalThis.fetch) {
  const model = ctx.model;
  const branch = event.branchEntries;
  const context = checkpointContext(buildSessionContext(branch).messages, branch, model);
  if (!context.ok) return context;
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools().filter(tool => active.has(tool.name));
  const instructions = [ctx.getSystemPrompt(), event.customInstructions].filter(Boolean).join("\n\n");
  return providerOperation(pi, ctx, model, event.signal, async (requestModel, requestAuth = {}) => {
    const observer = compactionObserver();
    let input, payloadError;
    const headers = { ...requestAuth.headers, "x-codex-beta-features": featureHeader(requestAuth.headers?.["x-codex-beta-features"] ?? requestModel.headers?.["x-codex-beta-features"]) };
    try {
      const response = await ctx.modelRegistry.complete(requestAuth.baseUrl ? { ...requestModel, baseUrl: requestAuth.baseUrl } : requestModel, {
        systemPrompt: instructions,
        messages: convertToLlm(context.value.messages),
        tools,
      }, {
        ...requestAuth,
        signal: requestAuth.signal ?? event.signal,
        // Pi has no raw WebSocket-event hook. Only this checkpoint operation uses SSE.
        transport: "sse",
        sessionId: ctx.sessionManager.getSessionId(),
        cacheRetention: "short",
        reasoningEffort: pi.getThinkingLevel() === "off" ? "none" : pi.getThinkingLevel(),
        headers,
        maxRetries: 0,
        fetch: async (url, options) => observer.wrap(await fetchImpl(url, options)),
        onPayload(payload) {
          const effective = context.value.checkpoint ? replaceMarker(payload, context.value.marker, context.value.checkpoint.details.replacementHistory) : success(payload);
          if (!effective.ok) { payloadError = effective.error; throw new Error(payloadError); }
          const compacted = compactionPayload(effective.value);
          if (!compacted.ok) { payloadError = compacted.error; throw new Error(payloadError); }
          input = structuredClone(effective.value.input);
          return compacted.value;
        },
      });
      if (payloadError) return failure(payloadError);
      if (response.stopReason !== "stop") return { ...failure(response.errorMessage || `Codex compaction stopped with ${response.stopReason}`), usage: response.usage };
      const observed = observer.result();
      if (!observed.ok) return { ...observed, usage: response.usage };
      return {
        ok: true,
        value: {
          kind: KIND,
          version: VERSION,
          modelKey: modelKey(requestModel),
          replacementHistory: [...retainRecentUsers(input), observed.value],
        },
        usage: response.usage,
      };
    } catch (error) { return failure(error); }
  });
}

export function checkpointSummary(model, sessionFile) {
  return [
    `Codex server-side checkpoint ${randomUUID()}.`,
    `Native model: ${modelKey(model)}. Account aliases do not change model identity.`,
    "The encrypted checkpoint replaces earlier context only for that model. A different model receives the retained messages below, not the encrypted history.",
    JSON.stringify({ type: "pi-stored-jsonl-history", version: 1, sessionFile: sessionFile ?? null, nativeCheckpointModel: modelKey(model), otherModels: "native-checkpoint-unavailable; retained-tail-only" }),
    sessionFile ? "The shared read-thread command reads and searches the original session JSONL." : "This in-memory session has no stored JSONL for history retrieval.",
  ].join("\n");
}

export default function codexCompaction(pi) {
  const block = (ctx, error) => {
    // Throwing alone does not block: Pi logs extension-handler errors and continues.
    void ctx.abort();
    ctx.ui.notify(`Codex checkpoint: ${error}`, "error");
  };
  pi.on("context", (event, ctx) => {
    const result = checkpointContext(event.messages, ctx.sessionManager.getBranch(), ctx.model);
    if (!result.ok) { block(ctx, result.error); return; }
    return { messages: result.value.messages };
  });
  pi.on("before_provider_headers", (event, ctx) => {
    if (!isCodex(ctx.model)) return;
    const name = Object.keys(event.headers).find(key => key.toLowerCase() === "x-codex-beta-features") ?? "x-codex-beta-features";
    event.headers[name] = featureHeader(event.headers[name]);
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodex(ctx.model)) return;
    const lookup = findCheckpoint(ctx.sessionManager.getBranch());
    if (!lookup.ok) { block(ctx, lookup.error); return; }
    const checkpoint = lookup.value;
    if (!checkpoint || checkpoint.details.modelKey !== modelKey(ctx.model)) return;
    const result = replaceMarker(event.payload, markerFor(checkpoint), checkpoint.details.replacementHistory);
    if (!result.ok) { block(ctx, result.error); return; }
    return result.value;
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (!isCodex(ctx.model)) return;
    let result;
    try { result = await createCheckpoint(pi, ctx, event); } catch (error) { result = failure(error); }
    if (!result.ok) {
      if (!event.signal.aborted) ctx.ui.notify(`Codex compaction failed: ${result.error}`, "error");
      return { cancel: true };
    }
    return {
      compaction: {
        summary: checkpointSummary(ctx.model, ctx.sessionManager.getSessionFile()),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: result.value,
        usage: result.usage,
      },
    };
  });
}
