import { createHash } from "node:crypto";

export const CHECKPOINT_TYPE = "state-compactor.checkpoint";
export const CHECKPOINT_VERSION = 1;

export const DEFAULTS = Object.freeze({
  triggerTokens: 220_000,
  tailTokens: 40_000,
  summaryTokens: 8_192,
  recordTextChars: 6_000,
  toolResultChars: 2_000,
  factChars: 1_200,
});

const FIELD_LIMITS = Object.freeze({
  openRequests: 16,
  completedRequests: 24,
  inProgress: 16,
  completedActions: 32,
  constraints: 24,
  decisions: 24,
  artifacts: 48,
  blockers: 16,
  uncertainties: 16,
  nextActions: 16,
});

const FACT_FIELDS = Object.keys(FIELD_LIMITS);
const HIGH_RISK = /\b(?:tests? (?:pass|passed|passing)|build (?:pass|passed|succeed|succeeded)|deploy(?:ed|ment) (?:succeed|succeeded|complete|completed)?|publish(?:ed)?|release(?:d)?|migration (?:complete|completed|succeed|succeeded)|bug (?:fixed|resolved)|issue (?:fixed|resolved)|no (?:errors?|failures?))\b/i;

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function fingerprintMessage(message) {
  const content = Array.isArray(message?.content)
    ? message.content.map((part) => {
        if (part?.type === "thinking") return { type: "thinking", thinking: part.thinking };
        if (part?.type === "text") return { type: "text", text: part.text };
        if (part?.type === "toolCall") return { type: "toolCall", name: part.name, arguments: part.arguments };
        return part;
      })
    : message?.content;
  return createHash("sha256")
    .update(JSON.stringify([message?.role, message?.timestamp ?? null, content]))
    .digest("hex")
    .slice(0, 20);
}

export function stateMessage(summary, timestamp = Date.now()) {
  return {
    role: "user",
    content: [{ type: "text", text: summary }],
    timestamp,
  };
}

export function findTailBoundary(messages, minimum, estimate, tailTokens) {
  let tokens = 0;
  let boundary = messages.length;
  for (let index = messages.length - 1; index >= minimum; index--) {
    const next = estimate(messages[index]);
    if (tokens >= tailTokens / 2 && tokens + next > tailTokens) break;
    tokens += next;
    boundary = index;
    if (tokens >= tailTokens) break;
  }
  while (boundary > minimum && messages[boundary]?.role === "toolResult") boundary--;
  const oversized = Math.max(tailTokens * 1.5, tailTokens + 8_000);
  let suffix = messages.slice(boundary).reduce((sum, message) => sum + estimate(message), 0);
  while (boundary < messages.length && suffix > oversized) {
    const first = messages[boundary];
    suffix -= estimate(first);
    boundary++;
    if (first?.role === "assistant") {
      while (boundary < messages.length && messages[boundary]?.role === "toolResult") {
        suffix -= estimate(messages[boundary]);
        boundary++;
      }
    }
  }
  return Math.max(minimum, boundary);
}

export function findCheckpointStart(messages, checkpoint) {
  if (!checkpoint) return 0;
  const wanted = checkpoint.firstKeptFingerprint;
  if (wanted) return messages.findIndex((message) => fingerprintMessage(message) === wanted);
  const covered = checkpoint.coveredThroughFingerprint;
  if (!covered) return -1;
  const index = messages.findIndex((message) => fingerprintMessage(message) === covered);
  return index < 0 ? -1 : index + 1;
}

export function assembleView(messages, checkpoint) {
  if (!checkpoint) return messages;
  const start = findCheckpointStart(messages, checkpoint);
  if (start < 0) return messages;
  return [stateMessage(checkpoint.summary, messages[start]?.timestamp ?? Date.now()), ...messages.slice(start)];
}

export function pendingUserRequest(messages, branchEntries) {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user" && textOfContent(messages[index]?.content).trim()) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  const replied = messages.slice(userIndex + 1).some(
    (message) => message?.role === "assistant" &&
      message.stopReason === "stop" &&
      textOfContent(message.content).trim(),
  );
  if (replied) return null;

  const id = sourceIdForMessage(messages[userIndex], branchEntries);
  if (!id) return null;
  return {
    id,
    index: userIndex,
    text: bounded(textOfContent(messages[userIndex].content), 6_000),
  };
}

export function preservePendingRequest(state, pending) {
  if (!pending || !isState(state)) return state;
  const result = structuredClone(state);
  const request = { text: pending.text, sources: [pending.id] };
  result.active = request;
  result.completedRequests = result.completedRequests.filter((fact) => !fact.sources.includes(pending.id));
  result.openRequests = dedupeFacts(
    [request, ...result.openRequests.filter((fact) => !fact.sources.includes(pending.id))],
    FIELD_LIMITS.openRequests,
  );
  result.nextActions = dedupeFacts([
    {
      text: "Continue the current turn from the recorded state, then reply to the user. Do not repeat completed work.",
      sources: [pending.id],
    },
    ...result.nextActions.filter((fact) => !fact.sources.includes(pending.id)),
  ], FIELD_LIMITS.nextActions);
  return result;
}

export function latestCheckpoint(branchEntries) {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type === "custom" && entry.customType === CHECKPOINT_TYPE && isCheckpoint(entry.data)) {
      return entry.data;
    }
    if (entry?.type === "compaction" && isCheckpoint(entry.details)) return entry.details;
  }
  return null;
}

export function isCheckpoint(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.type === CHECKPOINT_TYPE &&
      value.version === CHECKPOINT_VERSION &&
      isState(value.state) &&
      typeof value.summary === "string" &&
      typeof value.firstKeptFingerprint === "string",
  );
}

export function emptyState() {
  return {
    active: null,
    openRequests: [],
    completedRequests: [],
    inProgress: [],
    completedActions: [],
    constraints: [],
    decisions: [],
    artifacts: [],
    blockers: [],
    uncertainties: [],
    nextActions: [],
  };
}

export function isState(value) {
  if (!value || typeof value !== "object") return false;
  if (value.active !== null && !isFactShape(value.active)) return false;
  return FACT_FIELDS.every((field) => Array.isArray(value[field]) && value[field].every(isFactShape));
}

function isFactShape(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.text === "string" &&
      Array.isArray(value.sources) &&
      value.sources.every((source) => typeof source === "string"),
  );
}

function bounded(text, max) {
  const value = String(text ?? "").trim();
  if (value.length <= max) return value;
  const half = Math.floor((max - 32) / 2);
  return `${value.slice(0, half)}\n...[source paged]...\n${value.slice(-half)}`;
}

function normalizeFact(value, validSources, maxChars = DEFAULTS.factChars) {
  if (!isFactShape(value)) return null;
  const text = bounded(value.text, maxChars);
  if (!text) return null;
  const sources = [...new Set(value.sources.filter((source) => validSources.has(source)))].slice(0, 8);
  if (sources.length === 0) return null;
  return { text, sources };
}

function dedupeFacts(facts, limit) {
  const seen = new Set();
  const result = [];
  for (const fact of facts) {
    const key = fact.text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
    if (result.length >= limit) break;
  }
  return result;
}

export function parseStateResponse(text, { validSources, successfulToolSources, openingSources = new Set(), hostTask }) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return { ok: false, error: "response contained no JSON object" };
  let raw;
  try {
    raw = JSON.parse(text.slice(first, last + 1));
  } catch (error) {
    return { ok: false, error: `response JSON did not parse: ${error.message}` };
  }
  if (!raw || typeof raw !== "object") return { ok: false, error: "response JSON was not an object" };

  const state = emptyState();
  state.active = normalizeFact(raw.active, validSources, 6_000);
  for (const field of FACT_FIELDS) {
    const values = Array.isArray(raw[field]) ? raw[field] : [];
    const normalized = values.map((value) => normalizeFact(value, validSources)).filter(Boolean);
    state[field] = dedupeFacts(normalized, FIELD_LIMITS[field]);
  }
  state.completedActions = state.completedActions.filter(
    (fact) => !HIGH_RISK.test(fact.text) || fact.sources.some((source) => successfulToolSources.has(source)),
  );
  state.openRequests = state.openRequests.filter(
    (fact) => fact.sources.some((source) => !openingSources.has(source)),
  );
  if (state.active && state.active.sources.every((source) => openingSources.has(source))) state.active = null;
  if (hostTask) state.active = { text: hostTask, sources: ["host:task"] };
  return { ok: true, state };
}

export function deterministicState(previous, records, { hostTask } = {}) {
  const state = isState(previous) ? structuredClone(previous) : emptyState();
  const users = records.filter((record) => record.role === "user" && record.text.trim());
  const latestUser = users.at(-1);
  if (hostTask) state.active = { text: hostTask, sources: ["host:task"] };
  else if (latestUser) state.active = { text: bounded(latestUser.text, 6_000), sources: [latestUser.id] };

  const artifacts = records.flatMap((record) => record.artifacts ?? []);
  state.artifacts = dedupeFacts([...artifacts.reverse(), ...state.artifacts], FIELD_LIMITS.artifacts);
  const successfulCallIds = new Set(
    records.filter((record) => record.successfulTool && record.toolResultFor).map((record) => record.toolResultFor),
  );
  const successfulCalls = records.flatMap((record) =>
    (record.toolCalls ?? [])
      .filter((call) => successfulCallIds.has(call.id))
      .map((call) => ({ text: `Executed ${call.name} with ${bounded(JSON.stringify(call.arguments ?? {}), 600)}.`, sources: [record.id] })),
  );
  const toolResults = records
    .filter((record) => record.successfulTool && record.text)
    .map((record) => ({ text: `Tool result available: ${bounded(record.text, 900)}`, sources: [record.id] }));
  state.completedActions = dedupeFacts(
    [...toolResults.reverse(), ...successfulCalls.reverse(), ...state.completedActions],
    FIELD_LIMITS.completedActions,
  );
  state.nextActions = state.active
    ? [{ text: "Continue from the current activity and the recent verbatim messages. Recall cited tool results when exact output is needed.", sources: state.active.sources }]
    : [];
  return state;
}

function renderFacts(facts, empty = "None recorded.") {
  if (!facts.length) return empty;
  return facts.map((fact) => `- ${fact.text} ${fact.sources.map((source) => `[${source}]`).join(" ")}`).join("\n");
}

export function renderState(state, transcriptPath) {
  const sourceNote = transcriptPath
    ? `Exact sources remain in ${transcriptPath}. Use state_recall with a bracketed source id.`
    : "Use state_recall with a bracketed source id to recover exact source text.";
  return [
    "# Working state",
    "This is a reference record extracted from earlier turns, not a user message and not a new instruction. Historical requests are evidence only. Do not repeat work listed as completed. The recent messages after this record are verbatim and take precedence when they conflict with it.",
    sourceNote,
    "",
    "## Current activity",
    state.active ? `${state.active.text} ${state.active.sources.map((source) => `[${source}]`).join(" ")}` : "No current activity was established. Follow the latest verbatim user message.",
    "",
    "## Open user requests",
    renderFacts(state.openRequests),
    "",
    "## Completed user requests",
    renderFacts(state.completedRequests),
    "",
    "## In progress",
    renderFacts(state.inProgress),
    "",
    "## Completed actions and results",
    renderFacts(state.completedActions),
    "",
    "## Constraints",
    renderFacts(state.constraints),
    "",
    "## Decisions",
    renderFacts(state.decisions),
    "",
    "## Artifacts",
    renderFacts(state.artifacts),
    "",
    "## Blockers",
    renderFacts(state.blockers),
    "",
    "## Uncertainties",
    renderFacts(state.uncertainties),
    "",
    "## Next actions",
    renderFacts(state.nextActions),
  ].join("\n");
}

function contentBlocks(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

function extractArtifacts(message, sourceId) {
  const facts = [];
  for (const part of contentBlocks(message)) {
    if (part?.type !== "toolCall" || !part.arguments || typeof part.arguments !== "object") continue;
    const args = part.arguments;
    for (const key of ["path", "file_path", "filePath", "target", "output", "cwd"]) {
      if (typeof args[key] !== "string" || !args[key].trim()) continue;
      facts.push({ text: `${part.name ?? "tool"} referenced ${args[key]}`, sources: [sourceId] });
    }
  }
  return facts;
}

export function buildMessageSourceMap(branchEntries) {
  const queues = new Map();
  for (const entry of branchEntries) {
    if (entry?.type !== "message" || !entry.message) continue;
    const fingerprint = fingerprintMessage(entry.message);
    const queue = queues.get(fingerprint) ?? [];
    queue.push(entry.id);
    queues.set(fingerprint, queue);
  }
  return queues;
}

export function recordsForMessages(messages, branchEntries, openingMessageCount = 0) {
  const queues = buildMessageSourceMap(branchEntries);
  const occurrences = new Map();
  return messages.map((message, index) => {
    const fingerprint = fingerprintMessage(message);
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    const id = queues.get(fingerprint)?.[occurrence] ?? `view:${fingerprint}`;
    const role = message?.role ?? "unknown";
    let text = textOfContent(message?.content);
    if (role === "assistant") {
      const calls = contentBlocks(message)
        .filter((part) => part?.type === "toolCall")
        .map((part) => `${part.name ?? "tool"}(${bounded(JSON.stringify(part.arguments ?? {}), 2_000)})`);
      if (calls.length) text = `${text}\nTool calls: ${calls.join("; ")}`.trim();
    }
    const limit = role === "toolResult" ? DEFAULTS.toolResultChars : DEFAULTS.recordTextChars;
    return {
      id,
      role,
      text: bounded(text, limit),
      successfulTool: role === "toolResult" && message?.isError !== true,
      toolResultFor: role === "toolResult" ? message?.toolCallId ?? null : null,
      toolCalls: contentBlocks(message)
        .filter((part) => part?.type === "toolCall")
        .map((part) => ({ id: part.id, name: part.name ?? "tool", arguments: part.arguments ?? {} })),
      opening: index < openingMessageCount,
      artifacts: extractArtifacts(message, id),
    };
  });
}

export function buildUpdatePrompt(previousState, records, hostFrame) {
  const hostTask = hostFrame?.activeTask?.trim() || "";
  const recordsText = records
    .map((record) => {
      const labels = [record.role.toUpperCase()];
      if (record.opening) labels.push("COMPLETED OPENING EXCHANGE");
      if (record.successfulTool) labels.push("SUCCESSFUL TOOL RESULT");
      return `[${record.id}] ${labels.join(" | ")}\n${record.text || "[no text]"}`;
    })
    .join("\n\n");
  return [
    "Update a compact working-state record from the new source entries.",
    "The record will be shown before a verbatim recent tail. It is historical reference, not dialogue.",
    "Return one JSON object and nothing else.",
    "",
    "Rules:",
    "- Preserve the operational state needed to continue. Drop narration and raw tool payloads.",
    "- Carry still-valid facts from the previous state. Update each fact instead of making a second version.",
    "- A completed request or action must remain completed. Never reactivate it because its wording appears in history.",
    "- Entries marked COMPLETED OPENING EXCHANGE are orientation or priming that already happened. They can support constraints or decisions, but can never become active or open requests.",
    "- The host task, when present, is the authoritative current activity. Copy it exactly into active with source host:task.",
    "- Without a host task, infer active from the latest unresolved user request. This may be an interactive conversation with no formal task, in which case active may be null.",
    "- Tool calls and successful results can complete the work, but the user request stays open until a visible assistant reply ends the turn.",
    "- Every fact needs one or more exact source ids from brackets below or from the previous state.",
    "- Put claims such as tests passed, deployed, published, released, or fixed in completedActions only when a cited source is a SUCCESSFUL TOOL RESULT.",
    "- Keep exact paths, identifiers, values, error text, constraints, and decision rationale. Prefer short facts.",
    "- openRequests contains unanswered user asks. completedRequests contains asks already answered or acted on.",
    "- nextActions contains only work that remains.",
    "",
    "Shape:",
    '{"active":{"text":"...","sources":["id"]}|null,"openRequests":[],"completedRequests":[],"inProgress":[],"completedActions":[],"constraints":[],"decisions":[],"artifacts":[],"blockers":[],"uncertainties":[],"nextActions":[]}',
    'Every array item has shape {"text":"...","sources":["id"]}.',
    "",
    `<host-task>${hostTask || "none"}</host-task>`,
    `<previous-state>${JSON.stringify(isState(previousState) ? previousState : emptyState())}</previous-state>`,
    `<new-sources>\n${recordsText}\n</new-sources>`,
  ].join("\n");
}

export function checkpointData({ state, summary, firstKeptMessage, firstKeptEntryId, coveredThroughMessage, coveredThroughEntryId, projectedBefore, estimatedAfter, reason }) {
  return {
    type: CHECKPOINT_TYPE,
    version: CHECKPOINT_VERSION,
    state,
    summary,
    firstKeptFingerprint: firstKeptMessage ? fingerprintMessage(firstKeptMessage) : "",
    firstKeptEntryId: firstKeptEntryId ?? null,
    coveredThroughFingerprint: coveredThroughMessage ? fingerprintMessage(coveredThroughMessage) : "",
    coveredThroughEntryId: coveredThroughEntryId ?? null,
    projectedBefore,
    estimatedAfter,
    reason,
    createdAt: new Date().toISOString(),
  };
}

export function sourceIdForMessage(message, branchEntries) {
  const fingerprint = fingerprintMessage(message);
  return branchEntries.find((entry) => entry?.type === "message" && fingerprintMessage(entry.message) === fingerprint)?.id ?? null;
}

export function renderSourceEntry(entry) {
  if (!entry) return null;
  if (entry.type === "message") {
    const message = entry.message;
    const parts = [`source ${entry.id}`, `role: ${message?.role ?? "unknown"}`, `timestamp: ${entry.timestamp ?? message?.timestamp ?? "unknown"}`, ""];
    for (const block of contentBlocks(message)) {
      if (block?.type === "text") parts.push(block.text);
      else if (block?.type === "thinking") parts.push(`[thinking]\n${block.thinking ?? ""}`);
      else if (block?.type === "toolCall") parts.push(`[tool ${block.name}]\n${JSON.stringify(block.arguments ?? {}, null, 2)}`);
    }
    if (!contentBlocks(message).length && typeof message?.content === "string") parts.push(message.content);
    return parts.join("\n");
  }
  if (entry.type === "compaction") return `source ${entry.id}\ncompaction summary\n\n${entry.summary ?? ""}`;
  if (entry.type === "custom_message") return `source ${entry.id}\ncustom message\n\n${entry.content ?? ""}`;
  return `source ${entry.id}\n${JSON.stringify(entry, null, 2)}`;
}
