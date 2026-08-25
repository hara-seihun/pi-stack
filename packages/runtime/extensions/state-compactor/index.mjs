import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  CHECKPOINT_TYPE,
  DEFAULTS,
  assembleView,
  buildUpdatePrompt,
  checkpointData,
  deterministicState,
  findCheckpointStart,
  findTailBoundary,
  fingerprintMessage,
  latestCheckpoint,
  parseStateResponse,
  pendingUserRequest,
  preservePendingRequest,
  recordsForMessages,
  renderSourceEntry,
  renderState,
  sourceIdForMessage,
  stateMessage,
} from "./state.mjs";

function estimateMessageTokens(message) {
  const wire = {
    role: message?.role,
    content: message?.content,
    toolCallId: message?.toolCallId,
    toolName: message?.toolName,
  };
  try {
    return Math.max(1, Math.ceil(JSON.stringify(wire).length / 4));
  } catch {
    return 1;
  }
}

function configuredTrigger() {
  const raw = process.env.PI_STATE_COMPACTOR_TRIGGER;
  if (raw === undefined) return DEFAULTS.triggerTokens;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 10_000) {
    console.error(`state-compactor: ignoring invalid PI_STATE_COMPACTOR_TRIGGER=${raw}`);
    return DEFAULTS.triggerTokens;
  }
  return Math.min(value, DEFAULTS.triggerTokens);
}

function promptTokens(message) {
  if (message?.role !== "assistant" || !message.usage || message.stopReason === "error") return null;
  const usage = message.usage;
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function hostFrame(ctx) {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!sessionId) return null;
  return globalThis.__piWorkingStateHosts?.get?.(sessionId) ?? null;
}

function branchEntryMessage(entry) {
  if (entry?.type === "message") return entry.message;
  if (entry?.type === "custom_message") {
    return { role: "user", content: [{ type: "text", text: String(entry.content ?? "") }], timestamp: entry.timestamp };
  }
  return null;
}

function branchMessageById(branch, id) {
  return branchEntryMessage(branch.find((entry) => entry?.id === id));
}

function responseText(response) {
  const content = response?.content ?? [];
  const visible = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (visible) return visible;
  return content
    .filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
    .map((part) => part.thinking)
    .join("\n")
    .trim();
}

function writeAlert(title, body) {
  const directory = process.env.PI_STATE_COMPACTOR_ALERTS;
  if (!directory) return;
  try {
    mkdirSync(directory, { recursive: true });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(directory, `${stamp}-${slug}.md`), `# ${title}\n\n- host: ${hostname()}\n- source: state-compactor\n- time: ${new Date().toISOString()}\n\n${body}\n`);
  } catch (error) {
    console.error(`state-compactor: could not write alert: ${error?.message ?? error}`);
  }
}

function viewHash(messages) {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(fingerprintMessage(message));
  return hash.digest("hex");
}

function stateHash(checkpoint) {
  return createHash("sha256").update(JSON.stringify(checkpoint.state)).digest("hex");
}

function appendAudit(ctx, checkpoint, messages, estimatedTokens) {
  const transcript = ctx.sessionManager?.getSessionFile?.();
  if (!transcript) return;
  const branch = ctx.sessionManager.getBranch();
  const line = {
    time: new Date().toISOString(),
    sessionId: ctx.sessionManager.getSessionId?.() ?? null,
    leafId: ctx.sessionManager.getLeafId?.() ?? null,
    firstKeptEntryId: checkpoint.firstKeptEntryId,
    checkpointCreatedAt: checkpoint.createdAt,
    stateHash: stateHash(checkpoint),
    viewHash: viewHash(messages),
    estimatedTokens: Math.round(estimatedTokens),
    branchEntries: branch.length,
  };
  try {
    const auditFile = transcript.endsWith(".jsonl")
      ? `${transcript.slice(0, -6)}.state-views.ndjson`
      : `${transcript}.state-views.ndjson`;
    appendFileSync(auditFile, `${JSON.stringify(line)}\n`);
  } catch (error) {
    console.error(`state-compactor: could not append view audit: ${error?.message ?? error}`);
  }
}

function dynamicBudgets(ctx, trigger) {
  const window = Number(ctx.model?.contextWindow ?? 0);
  const safeWindow = window > 0 ? Math.max(10_000, window - 32_000) : trigger;
  const activeTrigger = Math.min(trigger, safeWindow);
  return {
    trigger: activeTrigger,
    tail: Math.min(DEFAULTS.tailTokens, Math.max(8_000, Math.floor(activeTrigger * 0.22))),
  };
}

function successfulSources(branch, records) {
  const result = new Set(records.filter((record) => record.successfulTool).map((record) => record.id));
  for (const entry of branch) {
    if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.isError !== true) {
      result.add(entry.id);
    }
  }
  return result;
}

function knownSources(branch, records, frame) {
  const result = new Set(branch.map((entry) => entry?.id).filter((id) => typeof id === "string"));
  for (const record of records) if (!record.id.startsWith("view:")) result.add(record.id);
  if (frame?.activeTask?.trim()) result.add("host:task");
  return result;
}

async function generateState({ ctx, signal, previousState, messages, branch, frame, openingCount, pendingUser }) {
  const records = recordsForMessages(messages, branch, openingCount).filter((record) => !record.id.startsWith("view:"));
  const finalize = (state) => preservePendingRequest(state, pendingUser);
  const fallback = () => finalize(deterministicState(previousState, records, { hostTask: frame?.activeTask?.trim() || "" }));
  if (!ctx.model || records.length === 0) return { state: fallback(), usage: undefined, degraded: records.length > 0 };

  const prompt = buildUpdatePrompt(previousState, records, frame);
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      {
        maxTokens: DEFAULTS.summaryTokens,
        signal,
        cacheRetention: "none",
        sessionId: randomUUID(),
        reasoningEffort: "low",
      },
    );
    const parsed = parseStateResponse(responseText(response), {
      validSources: knownSources(branch, records, frame),
      successfulToolSources: successfulSources(branch, records),
      openingSources: new Set(records.filter((record) => record.opening).map((record) => record.id)),
      hostTask: frame?.activeTask?.trim() || "",
    });
    if (parsed.ok) return { state: finalize(parsed.state), usage: response.usage, degraded: false };
    const blocks = (response.content ?? []).map((part) => {
      const length = typeof part?.text === "string"
        ? part.text.length
        : typeof part?.thinking === "string"
          ? part.thinking.length
          : 0;
      return `${part?.type ?? "unknown"}:${length}`;
    });
    return {
      state: fallback(),
      usage: response.usage,
      degraded: true,
      error: `${parsed.error}; stop=${response.stopReason ?? "unknown"}; blocks=${blocks.join(",") || "none"}`,
    };
  } catch (error) {
    return { state: fallback(), usage: undefined, degraded: true, error: error?.message ?? String(error) };
  }
}

export default function stateCompactor(pi) {
  const configured = configuredTrigger();
  let active = null;
  let ratio = 1.6;
  let previousEstimate = null;
  let checkpointing = null;
  let alerted = false;

  const reset = () => {
    active = null;
    ratio = 1.6;
    previousEstimate = null;
    checkpointing = null;
    alerted = false;
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("model_select", () => {
    ratio = 1.6;
    previousEstimate = null;
  });

  pi.registerTool({
    name: "state_recall",
    label: "Recall compacted source",
    description: "Read an exact source cited by the compacted working-state record. Supports paging for large sources.",
    promptSnippet: "Recover exact source text cited in the working-state record",
    promptGuidelines: ["Use state_recall only when an exact compacted source is needed; use the bracketed source id and page large sources with offset."],
    parameters: {
      type: "object",
      properties: {
        source_id: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        max_chars: { type: "integer", minimum: 1, maximum: 50_000 },
      },
      required: ["source_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sourceId = params.source_id;
      let text;
      if (sourceId === "host:task") text = hostFrame(ctx)?.activeTask ?? null;
      else text = renderSourceEntry(ctx.sessionManager.getBranch().find((entry) => entry?.id === sourceId));
      if (text === null) {
        return { content: [{ type: "text", text: `Source ${sourceId} is not on the current branch.` }], details: { found: false } };
      }
      const offset = params.offset ?? 0;
      const maxChars = params.max_chars ?? 20_000;
      const page = text.slice(offset, offset + maxChars);
      const nextOffset = offset + page.length < text.length ? offset + page.length : null;
      return {
        content: [{ type: "text", text: page || "[empty page]" }],
        details: { found: true, sourceId, offset, totalChars: text.length, nextOffset },
      };
    },
  });

  pi.on("context", async (event, ctx) => {
    const rawMessages = event.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return;
    const branch = ctx.sessionManager.getBranch();
    active = latestCheckpoint(branch) ?? active;

    let currentView = assembleView(rawMessages, active);
    const lastAssistant = [...currentView].reverse().find((message) => message?.role === "assistant");
    const billed = promptTokens(lastAssistant);
    if (billed !== null && previousEstimate && previousEstimate > 0) {
      const observed = billed / previousEstimate;
      if (Number.isFinite(observed)) ratio = Math.min(3, Math.max(1, 0.5 * ratio + 0.5 * observed));
    }

    const estimate = (message) => estimateMessageTokens(message);
    const budgets = dynamicBudgets(ctx, configured);
    let estimated = currentView.reduce((sum, message) => sum + estimate(message), 0);
    const projected = estimated * ratio;

    if (projected >= budgets.trigger) {
      if (!checkpointing) {
        checkpointing = (async () => {
          const checkpointStart = findCheckpointStart(rawMessages, active);
          const start = checkpointStart < 0 ? 0 : checkpointStart;
          const tailBudget = budgets.tail / ratio;
          const boundary = findTailBoundary(rawMessages, start, estimate, tailBudget);
          if (boundary <= start) return null;
          const frame = hostFrame(ctx);
          const openingCount = Math.max(0, Number(frame?.openingMessageCount ?? 0) - start);
          const pending = frame?.activeTask?.trim() ? null : pendingUserRequest(rawMessages, branch);
          const generated = await generateState({
            ctx,
            signal: ctx.signal,
            previousState: active?.state,
            messages: rawMessages.slice(start, boundary),
            branch,
            frame,
            openingCount,
            pendingUser: pending && pending.index < boundary ? pending : null,
          });
          const summary = renderState(generated.state, ctx.sessionManager.getSessionFile?.());
          const firstKept = rawMessages[boundary];
          const coveredMessage = rawMessages[boundary - 1];
          const firstKeptEntryId = firstKept ? sourceIdForMessage(firstKept, branch) : null;
          const covered = sourceIdForMessage(coveredMessage, branch);
          const provisional = [stateMessage(summary, firstKept?.timestamp ?? Date.now()), ...rawMessages.slice(boundary)];
          const after = provisional.reduce((sum, message) => sum + estimate(message), 0) * ratio;
          const checkpoint = checkpointData({
            state: generated.state,
            summary,
            firstKeptMessage: firstKept,
            firstKeptEntryId,
            coveredThroughMessage: coveredMessage,
            coveredThroughEntryId: covered,
            projectedBefore: projected,
            estimatedAfter: after,
            reason: "request-cap",
          });
          pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
          if (generated.degraded && !alerted) {
            alerted = true;
            const detail = `Session ${ctx.sessionManager.getSessionId?.() ?? "unknown"} used deterministic state extraction because the checkpoint model failed${generated.error ? `: ${generated.error}` : "."}`;
            console.error(`state-compactor: ${detail}`);
            writeAlert("state compactor used deterministic extraction", detail);
          }
          console.error(
            `state-compactor checkpoint: projected ${Math.round(projected).toLocaleString()} -> ${Math.round(after).toLocaleString()} tokens; summarized ${boundary - start} messages and kept ${rawMessages.length - boundary} verbatim.`,
          );
          return checkpoint;
        })().finally(() => {
          checkpointing = null;
        });
      }
      const created = await checkpointing;
      if (created) active = created;
      currentView = assembleView(rawMessages, active);
      estimated = currentView.reduce((sum, message) => sum + estimate(message), 0);
    }

    estimated = currentView.reduce((sum, message) => sum + estimate(message), 0);
    previousEstimate = estimated;
    if (active) appendAudit(ctx, active, currentView, estimated * ratio);
    return active || currentView !== rawMessages ? { messages: currentView } : undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const branch = event.branchEntries ?? ctx.sessionManager.getBranch();
    const previous = latestCheckpoint(branch) ?? active;
    const all = [...(event.preparation.messagesToSummarize ?? []), ...(event.preparation.turnPrefixMessages ?? [])];
    if (all.length === 0) return;
    const checkpointStart = findCheckpointStart(all, previous);
    const start = checkpointStart < 0 ? 0 : checkpointStart;
    const delta = all.slice(start);
    const frame = hostFrame(ctx);
    const openingCount = Math.max(0, Number(frame?.openingMessageCount ?? 0) - start);
    const branchMessages = branch.map(branchEntryMessage).filter(Boolean);
    const pending = frame?.activeTask?.trim() ? null : pendingUserRequest(branchMessages, branch);
    const summarizedIds = new Set(delta.map((message) => sourceIdForMessage(message, branch)).filter(Boolean));
    const generated = await generateState({
      ctx,
      signal: event.signal,
      previousState: previous?.state,
      messages: delta,
      branch,
      frame,
      openingCount,
      pendingUser: pending && summarizedIds.has(pending.id) ? pending : null,
    });
    const state = generated.state;
    const summary = renderState(state, ctx.sessionManager.getSessionFile?.());
    const firstKept = branchMessageById(branch, event.preparation.firstKeptEntryId) ?? all.at(-1);
    if (!firstKept) return;
    const checkpoint = checkpointData({
      state,
      summary,
      firstKeptMessage: firstKept,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      coveredThroughMessage: all.at(-1),
      coveredThroughEntryId: sourceIdForMessage(all.at(-1), branch),
      projectedBefore: event.preparation.tokensBefore,
      estimatedAfter: null,
      reason: "native-compaction",
    });
    active = checkpoint;
    if (generated.degraded && !alerted) {
      alerted = true;
      const detail = `Native compaction in session ${ctx.sessionManager.getSessionId?.() ?? "unknown"} used deterministic state extraction${generated.error ? `: ${generated.error}` : "."}`;
      console.error(`state-compactor: ${detail}`);
      writeAlert("state compactor used deterministic extraction", detail);
    }
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: checkpoint,
        usage: generated.usage,
      },
    };
  });
}
