import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  CFG,
  buildView,
  estimateView,
  fallbackMessage,
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

function billedPromptTokens(message) {
  if (message?.role !== "assistant" || !message.usage) return null;
  const usage = message.usage;
  const tokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

function assistantMessages(messages) {
  return messages.filter((message) => message?.role === "assistant");
}

function clampRatio(ratio) {
  return Math.min(CFG.ratioMax, Math.max(CFG.ratioMin, ratio));
}

export default function (pi) {
  if (process.env.PI_CONTEXT_GUARD === "off") return;

  const state = {
    watermark: 1,
    summary: null,
    step: 0,
    lastCutStep: -Infinity,
    ratio: CFG.initialRatio,
    calibrated: false,
    pendingRequest: null,
    alerted: { thrash: false, floor: false },
    lastLen: 0,
    headStamp: null,
    summarizing: false,
  };

  const reset = () => {
    state.watermark = 1;
    state.summary = null;
    state.step = 0;
    state.lastCutStep = -Infinity;
    state.ratio = CFG.initialRatio;
    state.calibrated = false;
    state.pendingRequest = null;
    state.alerted = { thrash: false, floor: false };
    state.lastLen = 0;
    state.headStamp = null;
    state.summarizing = false;
  };

  const resetCalibration = () => {
    state.ratio = CFG.initialRatio;
    state.calibrated = false;
    state.pendingRequest = null;
  };

  pi.on("session_compact", reset);
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("model_select", resetCalibration);

  pi.on("context", async (event, ctx) => {
    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length < 2) return;

    if (messages.length < state.lastLen || (state.headStamp !== null && messages[0]?.timestamp !== state.headStamp)) {
      reset();
    }
    state.lastLen = messages.length;
    state.headStamp = messages[0]?.timestamp ?? null;
    state.step++;

    const transcript = ctx.sessionManager?.getSessionFile?.() ?? undefined;
    const note = transcript ?? "";
    const assistants = assistantMessages(messages);
    const assistantCount = assistants.length;

    if (state.pendingRequest && assistantCount > state.pendingRequest.assistantCount) {
      const promptTokens = billedPromptTokens(assistants.at(-1));
      if (promptTokens !== null && state.pendingRequest.viewEstimate > 0) {
        const observed = promptTokens / state.pendingRequest.viewEstimate;
        if (Number.isFinite(observed)) {
          state.ratio = state.calibrated
            ? clampRatio(0.5 * state.ratio + 0.5 * observed)
            : clampRatio(observed);
          state.calibrated = true;
        }

        if (
          state.pendingRequest.cutStep !== null &&
          promptTokens > CFG.trigger - CFG.floorHeadroom &&
          !state.alerted.floor
        ) {
          state.alerted.floor = true;
          const msg = `context-guard cut, and the cut request actually billed ~${promptTokens.toLocaleString()} prompt tokens (> trigger - ${CFG.floorHeadroom.toLocaleString()}) in session ${ctx.sessionManager?.getSessionId?.() ?? "unknown"} (${transcript ?? "no file"}). The pinned head or unevictable residue is too large relative to the ${CFG.trigger.toLocaleString()} trigger; expect thrashing until this is fixed.`;
          console.error(msg);
          writeAlert("context-guard floor too high", msg);
        }
      }
      state.pendingRequest = null;
    } else if (state.pendingRequest && assistantCount < state.pendingRequest.assistantCount) {
      reset();
      state.lastLen = messages.length;
      state.headStamp = messages[0]?.timestamp ?? null;
      state.step = 1;
    }

    if (!state.calibrated && state.pendingRequest === null && assistantCount > 0) {
      state.ratio = CFG.ratioMax;
    }

    const viewEst = estimateView(messages, state, estimateTokens, note);
    const projected = viewEst * state.ratio;

    const rememberRequest = (viewEstimate, cutStep = null) => {
      state.pendingRequest = { assistantCount, viewEstimate, cutStep };
    };

    if (projected < CFG.trigger) {
      const view = buildView(messages, state, estimateTokens, note);
      rememberRequest(view ? estimateView(messages, state, estimateTokens, note) : viewEst);
      return view ? { messages: view } : undefined;
    }

    if (state.step - state.lastCutStep < CFG.quietSteps && !state.alerted.thrash) {
      state.alerted.thrash = true;
      const msg = `context-guard cut twice within ${CFG.quietSteps} steps in session ${ctx.sessionManager?.getSessionId?.() ?? "unknown"} (${transcript ?? "no file"}). This is the thrash failure mode (cf. Claude Code 2026-04-23 postmortem); the cap is still enforced, but investigate why the floor is so close to the trigger.`;
      console.error(msg);
      writeAlert("context-guard thrashing", msg);
    }

    const cutCfg = { ...CFG, tailTokens: CFG.tailTokens / state.ratio };
    const { boundary, landEstimate } = planCut(messages, state, estimateTokens, cutCfg, note);
    const landTokens = landEstimate * state.ratio;

    if (landTokens > CFG.residueMax && !state.summarizing) {
      state.summarizing = true;
      let summarized = false;
      try {
        const candidateState = { ...state, watermark: boundary };
        const candidateView = buildView(messages, candidateState, estimateTokens, note) ?? messages;
        if (landTokens >= CFG.trigger) {
          console.error(
            `context-guard: transformed handoff input still projects ~${Math.round(landTokens).toLocaleString()} tokens; using deterministic hard compaction without another oversized provider call.`,
          );
        } else if (ctx.model) {
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
              { messages: [...candidateView, ask] },
              {
                maxTokens: CFG.summaryMaxTokens,
                signal: controller.signal,
                sessionId: ctx.sessionManager?.getSessionId?.(),
                reasoningEffort: "low",
              },
            );
            const text = (response.content ?? [])
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n")
              .trim();
            if (text) {
              state.summary = {
                message: summaryMessage(text, transcript, Date.now()),
                coversUpTo: boundary,
              };
              summarized = true;
            } else {
              console.error(
                `context-guard: handoff summary returned no text (stopReason ${response.stopReason ?? "unknown"}` +
                `${response.errorMessage ? `, error: ${response.errorMessage}` : ""}); using deterministic hard compaction.`,
              );
            }
          } finally {
            clearTimeout(timer);
          }
        } else {
          console.error("context-guard: no handoff model is available; using deterministic hard compaction.");
        }
      } catch (error) {
        console.error(`context-guard: handoff summary failed; using deterministic hard compaction: ${error?.message ?? error}`);
      } finally {
        if (!summarized) {
          state.summary = {
            message: fallbackMessage(transcript, Date.now()),
            coversUpTo: boundary,
          };
        }
        state.summarizing = false;
      }
    }

    state.watermark = boundary;
    state.lastCutStep = state.step;

    const view = buildView(messages, state, estimateTokens, note);
    const landedEstimate = view ? estimateView(messages, state, estimateTokens, note) : viewEst;
    const landed = landedEstimate * state.ratio;
    rememberRequest(landedEstimate, state.step);
    console.error(`context-guard cut at step ${state.step}: projected ~${Math.round(projected).toLocaleString()} -> estimated ~${Math.round(landed).toLocaleString()} tokens (ratio ${state.ratio.toFixed(2)}).`);

    return view ? { messages: view } : undefined;
  });
}
