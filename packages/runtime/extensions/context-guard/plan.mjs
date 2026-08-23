/**
 * Pure planning and transform functions for the context-guard extension.
 *
 * The guard maintains a monotone watermark over the session's message array:
 * messages with index < watermark are "old" and are sent in transformed form
 * (tool-result bodies evicted, reasoning blocks stripped, provider validation
 * metadata removed). Messages at or after the watermark — the verbatim tail —
 * cross every cut byte-identical, thinking blocks and signatures included.
 *
 * The head is a protected span, not just message 0: `state.protect` (default
 * 1) marks how many leading messages keep their voice across every cut —
 * user text, assistant text, thinking, and signatures, byte-identical. A host
 * that opens a session with a lived exchange the agent must keep recognizing
 * as its own (the orchestrator's opening pin) registers that span; rung 2,
 * summarization, and the tail boundary all begin after it.
 *
 * Rung 1 still applies inside the head. A tool result is not the agent's
 * words, and hosted opening exchanges are dominated by the tool payloads the
 * agent read while producing a few thousand tokens of its own: the math
 * fleet's pinned openings measured 87-91% tool-result bytes, so honoring them
 * byte-identical spent 84-119k billed tokens of a 250k cap on every request
 * for the session's whole life. That is what put the floor above the floor
 * alert's own threshold and made the cap thrash.
 *
 * All functions are pure: state in, state out. The estimator is injected.
 */

export const CFG = {
  /** Cut before any request is projected to reach this many prompt tokens. */
  trigger: 250_000,
  /** Verbatim tail preserved byte-identical across every cut, in BILLED
   *  tokens: the caller divides by its calibration ratio before planning, so
   *  the model sees ~50k real tokens regardless of how far the byte estimator
   *  undercounts for its tokenizer. */
  tailTokens: 50_000,
  /** If rungs 1-2 would land above this, escalate to a handoff summary.
   *  The transformed-message estimate excludes roughly 10-20k tokens of
   *  provider-visible system/tool overhead, so 125k is the largest safe view
   *  under the 150k measured-floor guard. */
  residueMax: 125_000,
  /** Alert if even a summary cut cannot land below trigger - floorHeadroom. */
  floorHeadroom: 100_000,
  /** Largest protected head the guard will honor, in estimator units, after
   *  its tool results are evicted. A host supplies the span as a message
   *  count; that count must not be able to spend the cap. Beyond this the pin
   *  is honored as far as it fits and the overflow is reported. */
  headMax: 40_000,
  /** Two cuts within this many LLM calls is thrashing: alert loudly. */
  quietSteps: 10,
  /** Output budget for the handoff summary call. */
  summaryMaxTokens: 8_192,
  /** Initial estimate->billed-tokens calibration ratio (Anthropic tokenizer
   *  bills well above byte/4 estimates; calibrated per session from usage). */
  initialRatio: 1.6,
  ratioMin: 1.0,
  ratioMax: 3.0,
};

/** Strip the provider item-id suffix from a tool call id ("call_x|fc_y" -> "call_x"). */
export const baseCallId = (id) => (typeof id === "string" ? id.split("|")[0] : id);

/**
 * First index eligible for rung 2 and summarization: the protected head ends
 * here.
 *
 * The host's registered span is honored only as far as its post-eviction cost
 * fits `headMax`, so a host-supplied message count can never consume the cap.
 * Pass the estimator to apply that budget; omit it to read the raw span.
 */
export function headEnd(messages, state, estimate, cfg = CFG) {
  const want = Math.min(Math.max(1, state.protect ?? 1), messages.length);
  if (!estimate) return want;
  let acc = 0;
  for (let i = 1; i < want; i++) {
    acc += messages[i].role === "toolResult" ? 0 : estimate(messages[i]);
    if (acc > cfg.headMax) return i;
  }
  return want;
}

/**
 * Transform one protected-head message: rung 1 only. The agent's own words
 * cross byte-identical; the tool payloads it read while saying them do not.
 */
export function transformHeadMessage(m, note, estimate) {
  return m.role === "toolResult" ? transformOldMessage(m, note, estimate) : m;
}

const isVerbatimRole = (m) => m.role !== "assistant" && m.role !== "toolResult";

/**
 * Transform one old (pre-watermark) message.
 * - toolResult: body replaced with a placeholder naming the tool and pointing
 *   at the greppable transcript; images dropped; call-id de-suffixed.
 * - assistant: thinking blocks removed; text/textSignature, toolCall item-id,
 *   and thoughtSignature validation metadata stripped; args kept verbatim.
 * - everything else (user, bashExecution, custom): untouched.
 */
export function transformOldMessage(m, note, estimate) {
  if (m.role === "toolResult") {
    const tokens = estimate ? estimate(m) : 0;
    const text =
      `[context-guard evicted this ${m.toolName} result (~${Math.round(tokens).toLocaleString()} tokens); ` +
      `re-run it if needed${note ? ", or grep the transcript named in the context-guard notice above" : ""}.]`;
    return {
      ...m,
      toolCallId: baseCallId(m.toolCallId),
      content: [{ type: "text", text }],
      details: undefined,
    };
  }
  if (m.role === "assistant") {
    const content = [];
    for (const block of m.content ?? []) {
      if (block.type === "thinking") continue;
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "toolCall") {
        content.push({
          type: "toolCall",
          id: baseCallId(block.id),
          name: block.name,
          arguments: block.arguments,
        });
      } else {
        content.push(block);
      }
    }
    if (content.length === 0) {
      content.push({ type: "text", text: "[context-guard: reasoning-only message elided]" });
    }
    return { ...m, content };
  }
  return m;
}

/**
 * Find the tail boundary: the smallest index whose suffix holds at least
 * tailTokens estimated model tokens. Never lands on a toolResult (walks back
 * to include the assistant message that issued the call), never goes below
 * minIndex, and never regresses below the current watermark.
 */
export function findTailBoundary(messages, minIndex, estimate, tailTokens) {
  let acc = 0;
  let b = messages.length - 1;
  for (let i = messages.length - 1; i > minIndex; i--) {
    acc += estimate(messages[i]);
    b = i;
    if (acc >= tailTokens) break;
  }
  while (b > minIndex && messages[b].role === "toolResult") b--;
  return Math.max(b, minIndex);
}

/**
 * One notice per view carries the transcript path, so the (potentially
 * hundreds of) eviction placeholders don't each repeat it.
 */
export function noticeMessage(note, timestamp) {
  const transcript = note
    ? ` The full session transcript remains greppable at: ${note}`
    : "";
  return {
    role: "user",
    content: [{
      type: "text",
      text:
        "[context-guard notice: Good news — this active view has just been compacted, so you have " +
        "substantial context headroom again. Your recent context is still here, and older tool results " +
        "and reasoning were evicted to enforce the context cap. The session's pre-compaction length " +
        `doesn't need to limit what you take on next; if there's more work, you're in a good position ` +
        `to keep going.${transcript}]`,
    }],
    timestamp,
  };
}

/**
 * Build the transformed view for the current state.
 * Layout: [ protected head | summary? | notice? | verbatim user-ish from summarized
 *           span | rung-1/2-transformed old messages | verbatim tail ].
 * Returns null when the state implies no modification.
 */
export function buildView(messages, state, estimate, note, cfg = CFG) {
  const { watermark, summary } = state;
  const head = headEnd(messages, state, estimate, cfg);
  // `state.cut` keeps rung 1 reaching the head once a cut has happened. A
  // watermark that has not passed the head means the old span is empty, which
  // used to read as "nothing to do" — but when the head is the bulk, that
  // silently sent the raw view and enforced nothing.
  if (!state.cut && watermark <= head && !summary) return null;
  const out = [];
  for (let i = 0; i < head; i++) out.push(transformHeadMessage(messages[i], note, estimate));
  if (summary) out.push(summary.message);
  const summaryEnd = summary ? Math.max(summary.coversUpTo, head) : head;
  if (watermark > head) {
    out.push(noticeMessage(summary ? "" : note, messages[0]?.timestamp));
  }
  for (let i = head; i < Math.min(watermark, messages.length); i++) {
    const m = messages[i];
    if (i < summaryEnd) {
      if (isVerbatimRole(m)) out.push(m);
    } else {
      out.push(transformOldMessage(m, note, estimate));
    }
  }
  for (let i = Math.max(watermark, head); i < messages.length; i++) out.push(messages[i]);
  return out;
}

/** Estimated tokens of the view that buildView would produce. */
export function estimateView(messages, state, estimate, note, cfg = CFG) {
  const view = buildView(messages, state, estimate, note, cfg) ?? messages;
  let total = 0;
  for (const m of view) total += estimate(m);
  return total;
}

/**
 * Component breakdown of the view a state would produce, in estimator units.
 * One source of truth for the cut log and the floor alert: a cut that lands
 * high must say which component held the tokens, or the next reader has to
 * reconstruct the whole session to find out.
 */
export function describeView(messages, state, estimate, note, cfg = CFG) {
  const head = headEnd(messages, state, estimate, cfg);
  const requested = Math.min(Math.max(1, state.protect ?? 1), messages.length);
  const summaryEnd = state.summary ? Math.max(state.summary.coversUpTo, head) : head;
  let headTokens = 0;
  for (let i = 0; i < head; i++) headTokens += estimate(transformHeadMessage(messages[i], note, estimate));
  let oldTokens = 0;
  for (let i = head; i < Math.min(state.watermark, messages.length); i++) {
    const m = messages[i];
    if (i < summaryEnd) oldTokens += isVerbatimRole(m) ? estimate(m) : 0;
    else oldTokens += estimate(transformOldMessage(m, note, estimate));
  }
  let tailTokens = 0;
  let tailCount = 0;
  for (let i = Math.max(state.watermark, head); i < messages.length; i++) {
    tailTokens += estimate(messages[i]);
    tailCount++;
  }
  const summaryTokens = state.summary ? estimate(state.summary.message) : 0;
  return {
    head,
    headTokens,
    headClamped: head < requested,
    headRequested: requested,
    oldTokens,
    summaryTokens,
    tailTokens,
    tailCount,
    total: headTokens + oldTokens + summaryTokens + tailTokens,
  };
}

/**
 * Plan a cut: pick the new watermark and report the estimated landing size of
 * a rungs-1-2 cut (in estimator units; caller applies its calibration ratio).
 */
export function planCut(messages, state, estimate, cfg, note) {
  const head = headEnd(messages, state, estimate, cfg);
  const boundary = Math.max(
    findTailBoundary(messages, head, estimate, cfg.tailTokens),
    state.watermark,
    head,
  );
  const landEstimate = estimateView(
    messages,
    { ...state, watermark: boundary },
    estimate,
    note,
    cfg,
  );
  return { boundary, landEstimate };
}

/** The handoff summary instruction appended to the live conversation. */
export function handoffInstruction(transcriptPath) {
  return [
    "[Context handoff request]",
    "Your context is about to be compacted mid-run. Write a handoff summary so that you (or another agent) can continue this task seamlessly given only the original task message, this summary, and the most recent messages. Use exactly these sections:",
    "## Intent — the task and the current strategy",
    "## Constraints — every hard requirement, prohibition, or instruction still in force",
    "## Ruled out — approaches tried and rejected, each with its reason",
    "## Artifacts — every file, path, or resource created, modified, or relied on (exact paths)",
    "## Key results — exact values, identifiers, statements, and error messages that matter",
    "## Next steps — what to do immediately after this summary",
    "Prefer exact strings over paraphrase. Anything you omit is recoverable only by grepping the transcript" +
      (transcriptPath ? ` at: ${transcriptPath}` : "."),
  ].join("\n");
}

/** Wrap a completed summary as the user message that replaces the summarized span. */
export function summaryMessage(text, transcriptPath, timestamp) {
  const headline =
    "[Context handoff summary — earlier messages were compacted mid-run." +
    (transcriptPath ? ` The full transcript remains greppable at: ${transcriptPath}]` : "]");
  return {
    role: "user",
    content: [{ type: "text", text: `${headline}\n\n${text}` }],
    timestamp,
  };
}

/**
 * A provider-independent last rung. If the model cannot write a handoff (for
 * example because that account became exhausted during the run), omit the
 * same old span deterministically instead of violating the cap and thrashing.
 * Original user messages and the verbatim tail remain in the view, and the
 * transcript pointer keeps every omitted artifact recoverable.
 */
export function fallbackMessage(transcriptPath, timestamp) {
  const pointer = transcriptPath
    ? ` Recover omitted details by grepping: ${transcriptPath}`
    : " Recover omitted details from the full session transcript.";
  return {
    role: "user",
    content: [{
      type: "text",
      text:
        "[Context hard-compaction fallback — the handoff model returned no usable text, so old " +
        `assistant/tool messages were omitted to keep the session healthy.${pointer}]`,
    }],
    timestamp,
  };
}
