import { createHash } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ActionEvidence, type ActionInput, type ActionResult, type ActionStore } from "./actions.js";
import { ActionHttpClient } from "./action-http-client.js";

export const ACTION_TOOL_NAMES = ["action_inspect", "action_submit", "action_reconcile"];
const nonempty = Type.String({ minLength: 1, maxLength: 1000 });
const evidenceSchema = Type.Object({ kind: Type.Union([Type.Literal("provider-receipt"), Type.Literal("provider-rejection"), Type.Literal("operator-observation")]), reference: nonempty, detail: nonempty });
type ToolAuthority = Pick<ActionStore, "close" | "submit" | "inspect" | "list" | "reconcile" | "retryNoEffect"> | ActionHttpClient;
export function registerActionTools(pi: ExtensionAPI, env: NodeJS.ProcessEnv, factory: () => ToolAuthority = () => new ActionHttpClient(env)): void {
  const run = async (operation: (store: ToolAuthority) => ActionResult<unknown> | Promise<ActionResult<unknown>>) => {
    let store: ToolAuthority | undefined;
    let result: ActionResult<unknown>;
    try { store = factory(); result = await operation(store); }
    catch (cause) { result = { ok: false, error: "unavailable", message: `Action authority unavailable; do not dispatch: ${String(cause)}` }; }
    finally { store?.close(); }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { actionResult: result }, isError: !result.ok };
  };
  const actor = env.PI_THREAD_ID;
  const requestIdentity = (id: string) => createHash("sha256").update(`${actor}:${id}`).digest("hex");
  pi.registerTool(defineTool({ name: "action_inspect", label: "Inspect external action",
    description: "Inspect this owner's canonical external-action authority across threads. Omit id for recent actions. Inflight/uncertain means no replay; succeeded means provider acceptance, not business-purpose completion. Raw browser, SMTP and provider API bypasses are not covered.",
    parameters: Type.Object({ id: Type.Optional(nonempty) }),
    execute: async (_id, input) => run(store => input.id ? store.inspect(input.id) : store.list()),
  }));
  pi.registerTool(defineTool({ name: "action_submit", label: "Reserve external intent",
    description: "Atomically reserve an owner-scoped canonical business intent and recipient contact before using an owned outbound transport. This does not send. Use the same canonical intent/payload at the telephone/mail/Signal adapter; only an accepted intent may be claimed. A new UUID or rephrased intent cannot bypass an unresolved recipient contact. Payload conflict is an error. Keep stable business identifiers in intentKey, never a retry UUID.",
    parameters: Type.Object({ intentKey: nonempty, recipients: Type.Array(nonempty, { minItems: 1, maxItems: 100 }), transport: nonempty, payload: Type.Record(Type.String(), Type.Unknown()), requestId: Type.Optional(nonempty) }),
    execute: async (id, input) => run(store => actor ? store.submit({ ...input, requestId: input.requestId ?? requestIdentity(id), threadId: actor } as ActionInput) : { ok: false, error: "invalid-input", message: "Action submission requires authenticated thread identity" }),
  }));
  pi.registerTool(defineTool({ name: "action_reconcile", label: "Reconcile external effect",
    description: "Record accountable evidence against an exact action revision. effect-confirmed needs a provider receipt; no-effect-confirmed needs affirmative provider rejection, never missing logs, timeout or elapsed time. resolve-purpose releases a confirmed recipient purpose, not an uncertain effect; an authenticated worker may resolve its own succeeded action at the exact revision without its manager. hold fences the purpose. retry only reopens a proved failed-before-effect intent. Recover/dispatch belong to the transport owner. Evidence is your explicit assertion: inspect the provider first; this tool does not verify it or confer authority to contact anyone.",
    parameters: Type.Object({ id: nonempty, expectedRevision: Type.Integer({ minimum: 1 }), decision: Type.Union([Type.Literal("effect-confirmed"), Type.Literal("no-effect-confirmed"), Type.Literal("resolve-purpose"), Type.Literal("hold"), Type.Literal("retry")]), evidence: evidenceSchema }),
    execute: async (_id, input) => run(store => {
      if (!actor) return { ok: false, error: "invalid-input", message: "Reconciliation requires authenticated thread identity" };
      return input.decision === "retry" ? store.retryNoEffect(input.id, input.expectedRevision, input.evidence as ActionEvidence, actor) : store.reconcile(input.id, input.expectedRevision, input.decision, input.evidence as ActionEvidence, actor);
    }),
  }));
}
