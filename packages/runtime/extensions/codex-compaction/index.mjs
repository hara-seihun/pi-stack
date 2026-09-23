import { randomUUID } from "node:crypto";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  KIND, VERSION, compactionObserver, compactionPayload,
  failure, featureHeader, findCheckpoint, isCodex, modelKey, replaceMarker,
  retainRecentUsers, success,
} from "./native.mjs";

import { ATTEMPT, abortFailure, blockedAttempt, cancellableResponse, operationScope } from "./operation.mjs";

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
  const savedSummaryIndex = saved.findIndex(message => message.role === "compactionSummary" && message.summary === checkpoint.entry.summary);
  if (savedSummaryIndex < 0) return failure("The saved Codex checkpoint summary is missing from Pi context");
  const kept = saved.slice(savedSummaryIndex + 1);
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

export async function createCheckpoint(pi, ctx, event, fetchImpl = globalThis.fetch, limits) {
  const scope = operationScope(event.signal, limits);
  if (event.attemptId) scope.trace.attemptId = event.attemptId;
  try {
    let result = await requestCheckpoint(pi, ctx, { ...event, signal: scope.signal }, fetchImpl, scope);
    if (scope.signal.aborted) result = { ...failure(abortFailure(scope.signal)), usage: result.usage };
    else if (!result.ok) result.error = abortFailure(scope.signal, result.error);
    return { ...result, diagnostic: scope.snapshot() };
  } finally { scope.close(); }
}

async function requestCheckpoint(pi, ctx, event, fetchImpl, scope) {
  const model = ctx.model;
  const branch = event.branchEntries;
  const context = checkpointContext(buildSessionContext(branch).messages, branch, model);
  if (!context.ok) return context;
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools().filter(tool => active.has(tool.name));
  const instructions = [ctx.getSystemPrompt(), event.customInstructions].filter(Boolean).join("\n\n");
  return providerOperation(pi, ctx, model, event.signal, async (requestModel, requestAuth = {}) => {
    scope.trace.provider = requestModel.provider;
    const observer = compactionObserver(event => {
      scope.trace.events++;
      scope.trace.lastEvent = event.type;
      if (event.response?.id) scope.trace.responseId = event.response.id;
      scope.progress("stream");
    }, bytes => { scope.trace.bytes += bytes; });
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
        fetch: async (url, options) => {
          scope.progress("headers");
          const response = await fetchImpl(url, options);
          scope.trace.httpStatus = response.status;
          scope.trace.requestId = response.headers.get("x-request-id") ?? undefined;
          scope.trace.headersMs = Date.now() - Date.parse(scope.trace.startedAt);
          scope.progress("stream");
          return observer.wrap(cancellableResponse(response, requestAuth.signal ?? event.signal));
        },
        onPayload(payload) {
          const effective = context.value.checkpoint ? replaceMarker(payload, context.value.marker, context.value.checkpoint.details.replacementHistory) : success(payload);
          if (!effective.ok) { payloadError = effective.error; throw new Error(payloadError); }
          const compacted = compactionPayload(effective.value);
          if (!compacted.ok) { payloadError = compacted.error; throw new Error(payloadError); }
          scope.trace.inputItems = effective.value.input.length;
          scope.trace.requestBytes = Buffer.byteLength(JSON.stringify(compacted.value));
          input = structuredClone(effective.value.input);
          return compacted.value;
        },
      });
      const serviceRetries = response.diagnostics?.filter(item => item.type === "provider_service_retry");
      if (serviceRetries?.length) scope.trace.serviceRetries = serviceRetries;
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

export function reportDiagnostic(ctx, phase, error, reason, diagnostic) {
  console.error(JSON.stringify({ component: "codex-compaction", phase, sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider, model: ctx.model?.id, reason, error, diagnostic }));
  ctx.ui.notify(`Codex ${phase}: ${error}`, "error");
}

export function recoveryMessage(attempt) {
  return `Native compaction ${attempt.state}: ${attempt.error ?? "interrupted before checkpoint commit"}. Context is unchanged. Automatic resubmission is blocked; retry with /compact or the compact RPC command, or switch model.`;
}

export default function codexCompaction(pi) {
  const block = (ctx, error) => {
    // Throwing alone does not block: Pi logs extension-handler errors and continues.
    void ctx.abort();
    reportDiagnostic(ctx, "request-blocked", error);
  };
  pi.on("context", (event, ctx) => {
    const held = isCodex(ctx.model) && blockedAttempt(ctx.sessionManager.getBranch(), modelKey(ctx.model));
    const result = held ? failure(recoveryMessage(held)) : checkpointContext(event.messages, ctx.sessionManager.getBranch(), ctx.model);
    if (!result.ok) {
      reportDiagnostic(ctx, "request-blocked", result.error);
      return { error: result.error };
    }
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
    const key = modelKey(ctx.model);
    const held = blockedAttempt(event.branchEntries, key);
    if (held && event.reason !== "manual") return { error: recoveryMessage(held) };
    const attempt = { attemptId: randomUUID(), modelKey: key, state: "started", reason: event.reason };
    pi.appendEntry(ATTEMPT, attempt);
    let result;
    try { result = await createCheckpoint(pi, ctx, { ...event, attemptId: attempt.attemptId }); } catch (error) { result = failure(error); }
    if (!result.ok) {
      const failed = { ...attempt, state: event.signal.aborted ? "cancelled" : "failed", error: result.error, diagnostic: result.diagnostic };
      pi.appendEntry(ATTEMPT, failed);
      reportDiagnostic(ctx, "compaction-failed", result.error, event.reason, result.diagnostic);
      return event.signal.aborted ? { cancel: true } : { error: recoveryMessage(failed) };
    }
    console.error(JSON.stringify({ component: "codex-compaction", phase: "checkpoint-ready", sessionId: ctx.sessionManager.getSessionId(), diagnostic: result.diagnostic }));
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
