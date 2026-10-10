import { createHash } from "node:crypto";

const effectLabel = /^(send(?: message| email| reply)?|submit(?: application| form)?|place order|confirm order|buy(?: now)?|pay(?: now)?|purchase|delete(?: account)?|transfer|publish|post(?: reply)?|unsubscribe)$/i;
const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 1000;
const digest = value => createHash("sha256").update(stable(value)).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const refusal = (error, message, action) => ({
  isError: true,
  content: [{ type: "text", text: message }],
  details: { resultCategory: "failure", failureCategory: "validation-error", actionResult: { ok: false, error, message, ...(action ? { action } : {}) } },
});

export const externalActionSchema = {
  type: "object", additionalProperties: false,
  required: ["intentKey", "recipients"],
  properties: {
    intentKey: { type: "string", minLength: 1, maxLength: 1000, description: "Stable business purpose, not a retry UUID. The same intent and recipients share one canonical fence across threads/hosts/transports." },
    recipients: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 1000 }, description: "Actual recipients or affected account identities; use verified mail/tel identities when known so cross-transport holds apply." },
  },
};

export function classifyBrowserEffect(params, contract) {
  function classified(args, stdin, depth = 0) {
    const tokens = contract.extractUpstreamCommandTokens(args);
    if (tokens[0] === "batch") {
      if (depth > 10) return true;
      return contract.getUpstreamEffectiveBatchSteps(tokens, stdin).some(step => classified(step, undefined, depth + 1));
    }
    if (tokens[0] === "chat" || tokens[0] === "confirm") return true;
    if (tokens[0] === "webmcp" && ["invoke", "result", "cancel"].includes(tokens[1])) return true;
    if (tokens[0] === "find" && tokens.includes("click")) {
      const name = tokens.indexOf("--name");
      return effectLabel.test(name === -1 ? tokens[2] ?? "" : tokens[name + 1] ?? "");
    }
    return false;
  }
  if (Array.isArray(params.args)) return classified(params.args, params.stdin);
  for (const [key, compile] of [["semanticAction", contract.compileAgentBrowserSemanticAction], ["job", contract.compileAgentBrowserJob]]) {
    if (params[key]) {
      const result = compile(params[key]);
      return result.compiled ? classified(result.compiled.args, result.compiled.stdin) : false;
    }
  }
  return false;
}

export function installBrowserEffectFence(tool, { loadContract, createAuthority, env }) {
  const nativeExecute = tool.execute.bind(tool);
  tool.parameters = { ...tool.parameters, properties: { ...tool.parameters.properties, externalAction: externalActionSchema } };
  tool.description += " Declared external effects require externalAction {intentKey,recipients} on a single args/semanticAction call. Send/submit/purchase/delete-labelled find clicks, chat, confirm and WebMCP execution require this fence. Native gesture success leaves effect uncertain until provider evidence is reconciled; never retry under a new UUID. Ordinary browsing remains usable; opaque DOM/eval/navigation effects are not universally classified.";
  tool.execute = function (toolCallId, params, signal, onUpdate, ctx) {
    if (!params || typeof params !== "object" || params.externalAction === undefined && !["args", "semanticAction", "job"].some(key => params[key] !== undefined)) return nativeExecute(toolCallId, params, signal, onUpdate, ctx);
    return execute(toolCallId, params, signal, onUpdate, ctx);
  };
  async function execute(toolCallId, params, signal, onUpdate, ctx) {
    let classified;
    let contract;
    try { contract = await loadContract(); classified = classifyBrowserEffect(params, contract); }
    catch { return refusal("unavailable", "Browser effect classifier unavailable; no native dispatch permitted."); }
    const declaration = params.externalAction;
    if (declaration === undefined && !classified) return nativeExecute(toolCallId, params, signal, onUpdate, ctx);
    if (!declaration || !text(declaration.intentKey) || !Array.isArray(declaration.recipients) || declaration.recipients.length < 1 || declaration.recipients.length > 100 || !declaration.recipients.every(text) || Object.keys(declaration).some(key => !["intentKey", "recipients"].includes(key))) {
      return refusal("invalid-input", "This browser effect requires externalAction with a stable intentKey and actual recipients before native dispatch.");
    }
    const { externalAction: _declaration, ...input } = params;
    const modes = ["args", "semanticAction", "script", "job", "qa", "electron", "sourceLookup", "networkSourceLookup"].filter(key => input[key] !== undefined);
    if (modes.length !== 1 || !["args", "semanticAction"].includes(modes[0]) || modes[0] === "args" && contract.extractUpstreamCommandTokens(input.args)[0] === "batch") {
      return refusal("invalid-input", "Declared browser effects require one args or semanticAction operation; split batch/job/script effects into separate fenced calls.");
    }
    const actor = env.PI_THREAD_ID;
    if (!text(actor) || !text(toolCallId)) return refusal("invalid-input", "Browser effect requires an authenticated thread and tool-call identity.");
    if (signal?.aborted) return refusal("invalid-input", "Browser effect cancelled before reservation; no native dispatch.");
    let authority;
    let ticket;
    let action;
    let entered = false;
    let result;
    try {
      authority = await createAuthority();
      const submitted = await authority.submit({
        ...declaration, transport: "browser", payload: { browserInputSha256: digest(input) },
        requestId: digest({ actor, toolCallId }), threadId: actor,
      });
      if (!submitted.ok) return refusal(submitted.error, submitted.message, submitted.action);
      action = submitted.value.action;
      if (submitted.value.disposition === "recipient-held" || action.state !== "accepted") {
        return {
          content: [{ type: "text", text: `Existing canonical browser action ${action.id}: ${action.state}. No native dispatch; inspect/reconcile its evidence, do not reset the retry identity.` }],
          details: { actionResult: submitted, externalAction: { id: action.id, state: action.state, dispatched: false } },
          isError: submitted.value.disposition === "recipient-held" || action.state !== "succeeded",
        };
      }
      const claimed = await authority.claim(action.id, actor);
      if (!claimed.ok) return refusal(claimed.error, claimed.message, claimed.action);
      ticket = claimed.value;
      const armed = await authority.dispatch(ticket);
      if (!armed.ok) return refusal(armed.error, armed.message, armed.action);
      entered = true;
      if (!signal?.aborted) result = await nativeExecute(toolCallId, input, signal, onUpdate, ctx);
    } catch {
      if (!ticket || !authority) return refusal("unavailable", "Canonical browser action response unavailable; no dispatch permitted without a confirmed fence.", action);
    }
    if (!ticket || !authority) return refusal("unavailable", "Browser action authority returned no dispatch ticket.", action);
    let finished;
    try {
      finished = await authority.finish(ticket, "uncertain", { nativeReturned: result !== undefined, nativeError: result?.isError === true, dispatchArmed: entered }, {
        kind: "operator-observation", reference: `browser:${ticket.id}`,
        detail: "Browser execution is a gesture receipt, not proof of provider effect or rejection. Inspect the actual provider before reconciliation; never replay this intent on timeout, abort or a new tool UUID.",
      });
    } catch { finished = { ok: false, error: "unavailable", message: "Canonical finish receipt unavailable; prior fence remains non-replayable." }; }
    return {
      ...(result ?? refusal("unavailable", "Native browser operation produced no receipt; effect uncertain, do not replay.", action)),
      content: [...(result?.content ?? []), { type: "text", text: `Canonical external action ${ticket.id}: ${finished.ok ? finished.value.state : "finish-unconfirmed"}. Inspect/reconcile provider evidence before any further contact; no automatic replay.` }],
      details: { ...(result?.details ?? {}), actionResult: finished, externalAction: { id: ticket.id, state: finished.ok ? finished.value.state : "finish-unconfirmed", dispatched: entered } },
      ...(!finished.ok || !result ? { isError: true } : {}),
    };
  }
}
