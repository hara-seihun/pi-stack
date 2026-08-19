/**
 * Pure planning and transform functions for the context-guard extension.
 *
 * The guard maintains a monotone watermark over the session's message array:
 * messages with index < watermark are "old" and are sent in transformed form
 * (tool-result bodies evicted, reasoning blocks stripped, provider validation
 * metadata removed). Messages at or after the watermark — the verbatim tail —
 * cross every cut byte-identical, thinking blocks and signatures included.
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
  /** If rungs 1-2 would land above this, escalate to a handoff summary. */
  residueMax: 140_000,
  /** Alert if even a summary cut cannot land below trigger - floorHeadroom. */
  floorHeadroom: 100_000,
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
  return {
    role: "user",
    content: [{
      type: "text",
      text:
        "[context-guard notice: older tool results and reasoning were evicted from this view to cap context. " +
        `The full session transcript remains greppable at: ${note}]`,
    }],
    timestamp,
  };
}

/**
 * Build the transformed view for the current state.
 * Layout: [ head(msg 0) | summary? | notice? | verbatim user-ish from summarized
 *           span | rung-1/2-transformed old messages | verbatim tail ].
 * Returns null when the state implies no modification.
 */
export function buildView(messages, state, estimate, note) {
  const { watermark, summary } = state;
  if (watermark <= 1 && !summary) return null;
  const out = [messages[0]];
  if (summary) out.push(summary.message);
  const summaryEnd = summary ? summary.coversUpTo : 1;
  if (note && watermark > summaryEnd) out.push(noticeMessage(note, messages[0]?.timestamp));
  for (let i = 1; i < Math.min(watermark, messages.length); i++) {
    const m = messages[i];
    if (i < summaryEnd) {
      if (isVerbatimRole(m)) out.push(m);
    } else {
      out.push(transformOldMessage(m, note, estimate));
    }
  }
  for (let i = Math.max(watermark, 1); i < messages.length; i++) out.push(messages[i]);
  return out;
}

/** Estimated tokens of the view that buildView would produce. */
export function estimateView(messages, state, estimate, note) {
  const view = buildView(messages, state, estimate, note) ?? messages;
  let total = 0;
  for (const m of view) total += estimate(m);
  return total;
}

/**
 * Plan a cut: pick the new watermark and report the estimated landing size of
 * a rungs-1-2 cut (in estimator units; caller applies its calibration ratio).
 */
export function planCut(messages, state, estimate, cfg, note) {
  const boundary = Math.max(
    findTailBoundary(messages, 1, estimate, cfg.tailTokens),
    state.watermark,
    1,
  );
  const landEstimate = estimateView(
    messages,
    { ...state, watermark: boundary },
    estimate,
    note,
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
