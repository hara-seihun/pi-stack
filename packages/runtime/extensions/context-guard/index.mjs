/**
 * context-guard — mid-run context cap for every pi session on this machine.
 *
 * pi only checks compaction at agent_end and before a new user prompt, so an
 * autonomous run (one prompt, hundreds of tool calls) historically grew to
 * 600-900k tokens, deep into GPT-5.6's 2x price tier at 272k and far past every
 * measured effective-context knee. This extension enforces the cap at the
 * `context` event, which fires before every LLM call.
 *
 * Mechanism (uniform across providers), evidence in README.md:
 *   rung 1  evict tool-result bodies older than the 50k verbatim tail
 *   rung 2  strip old thinking/reasoning blocks and validation metadata
 *   rung 3  in-context handoff summary when residue alone exceeds 140k
 * Cuts are deep and rare (land ~100-130k, then ~30+ quiet steps); the tail
 * crosses every cut byte-identical, signatures included; every placeholder and
 * summary points at the greppable session transcript.
 *
 * Escape hatch: PI_CONTEXT_GUARD=off disables all behavior.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  CFG,
  buildView,
  estimateView,
  handoffInstruction,
  planCut,
  summaryMessage,
} from "./plan.mjs";

const ALERTS_DIR = process.env.PI_CONTEXT_GUARD_ALERTS ?? "/home/kenan/data/alerts/inbox";

function writeAlert(title, body) {
  try {
    mkdirSync(ALERTS_DIR, { recursive: true });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const file = join(ALERTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.md`);
    writeFileSync(file, `# ${title}\n\n- host: ${hostname()}\n- source: context-guard\n- time: ${new Date().toISOString()}\n\n${body}\n`);
  } catch (error) {
    console.error(`context-guard: failed to write alert: ${error?.message ?? error}`);
  }
}

export default function (pi) {
  if (process.env.PI_CONTEXT_GUARD === "off") return;

  const state = {
    watermark: 1,
    summary: null,
    step: 0,
    lastCutStep: -Infinity,
    ratio: CFG.initialRatio,
    lastAnchor: null,
    /** Set while the usage anchor predates the last cut and overstates context. */
    pendingCut: null, // { preCutAnchor }
    /** Set after a cut until the provider bills the cut prompt. */
    floorProbe: null, // { step }
    alerted: { thrash: false, floor: false },
    lastLen: 0,
    headStamp: null,
    summarizing: false,
  };

  const reset = () => {
    state.watermark = 1;
    state.summary = null;
    state.lastCutStep = -Infinity;
    state.pendingCut = null;
    state.floorProbe = null;
    state.lastLen = 0;
    state.headStamp = null;
  };

  pi.on("session_compact", reset);
  pi.on("session_start", reset);

  pi.on("context", async (event, ctx) => {
    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length < 4) return;
    state.step++;

    // Structural reset: pi compaction, tree navigation, or session switch
    // rewrote the array we index into.
    if (messages.length < state.lastLen || (state.headStamp !== null && messages[0]?.timestamp !== state.headStamp)) {
      reset();
    }
    state.lastLen = messages.length;
    state.headStamp = messages[0]?.timestamp ?? null;

    const transcript = ctx.sessionManager?.getSessionFile?.() ?? undefined;
    const note = transcript ?? "";

    // --- Projection: how many prompt tokens would this request bill? ---
    const viewEst = estimateView(messages, state, estimateTokens, note);
    const anchor = ctx.getContextUsage?.()?.tokens ?? null;

    if (anchor !== null && anchor !== state.lastAnchor) {
      state.lastAnchor = anchor;
      // The floor guard reads the prompt the provider actually billed for the
      // cut request: a fresh anchor at a later step is that measurement. An
      // estimate scaled by the uncalibrated initial ratio cannot tell a healthy
      // landing from a real floor problem, and alerting on it demands agent
      // investigation of a session that is behaving exactly as designed.
      if (state.floorProbe && state.step > state.floorProbe.step) {
        state.floorProbe = null;
        if (anchor > CFG.trigger - CFG.floorHeadroom && !state.alerted.floor) {
          state.alerted.floor = true;
          const msg = `context-guard cut, and the provider still billed ~${anchor.toLocaleString()} prompt tokens (> trigger - ${CFG.floorHeadroom.toLocaleString()}) in session ${ctx.sessionManager?.getSessionId?.() ?? "unknown"} (${transcript ?? "no file"}). The pinned head or unevictable residue is too large relative to the ${CFG.trigger.toLocaleString()} trigger; expect thrashing until this is fixed.`;
          console.error(msg);
          writeAlert("context-guard floor too high", msg);
        }
      }
      if (state.pendingCut && anchor < state.pendingCut.preCutAnchor * 0.8) {
        state.pendingCut = null; // anchor now reflects a post-cut request
      }
      if (!state.pendingCut && viewEst > 0) {
        const observed = anchor / viewEst;
        if (Number.isFinite(observed)) {
          const blended = 0.5 * state.ratio + 0.5 * observed;
          state.ratio = Math.min(CFG.ratioMax, Math.max(CFG.ratioMin, blended));
        }
      }
    }

    let projected = viewEst * state.ratio;
    if (anchor !== null && !state.pendingCut) projected = Math.max(projected, anchor);

    if (projected < CFG.trigger) {
      const view = buildView(messages, state, estimateTokens, note);
      return view ? { messages: view } : undefined;
    }

    // --- Cut ---
    if (state.step - state.lastCutStep < CFG.quietSteps && !state.alerted.thrash) {
      state.alerted.thrash = true;
      const msg = `context-guard cut twice within ${CFG.quietSteps} steps in session ${ctx.sessionManager?.getSessionId?.() ?? "unknown"} (${transcript ?? "no file"}). This is the thrash failure mode (cf. Claude Code 2026-04-23 postmortem); the cap is still enforced, but investigate why the floor is so close to the trigger.`;
      console.error(msg);
      writeAlert("context-guard thrashing", msg);
    }

    const { boundary, landEstimate } = planCut(messages, state, estimateTokens, CFG, note);
    const landTokens = landEstimate * state.ratio;

    if (landTokens > CFG.residueMax && !state.summarizing && ctx.model) {
      // Rung 3: handoff summary over the live (cache-hot) conversation.
      state.summarizing = true;
      try {
        const view = buildView(messages, state, estimateTokens, note) ?? messages;
        const ask = {
          role: "user",
          content: [{ type: "text", text: handoffInstruction(transcript) }],
          timestamp: Date.now(),
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 240_000);
        try {
          const response = await ctx.modelRegistry.complete(
            ctx.model,
            { messages: [...view, ask] },
            {
              maxTokens: CFG.summaryMaxTokens,
              signal: controller.signal,
              sessionId: ctx.sessionManager?.getSessionId?.(),
            },
          );
          const text = (response.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
          if (text) {
            state.summary = {
              message: summaryMessage(text, transcript, Date.now()),
              coversUpTo: boundary,
            };
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        console.error(`context-guard: handoff summary failed, falling back to eviction: ${error?.message ?? error}`);
      } finally {
        state.summarizing = false;
      }
    }

    state.watermark = boundary;
    state.lastCutStep = state.step;
    state.pendingCut = { preCutAnchor: anchor ?? projected };
    state.floorProbe = { step: state.step };

    const view = buildView(messages, state, estimateTokens, note);
    const landed = view ? estimateView(messages, state, estimateTokens, note) * state.ratio : projected;
    console.error(`context-guard cut at step ${state.step}: projected ~${Math.round(projected).toLocaleString()} -> estimated ~${Math.round(landed).toLocaleString()} tokens (ratio ${state.ratio.toFixed(2)}).`);

    return view ? { messages: view } : undefined;
  });
}
