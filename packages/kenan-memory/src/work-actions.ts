import { createHash } from "node:crypto";
import { actionRequest, canonicalRecipient, type ActionInput, type ActionRecord, type ActionResult, type ActionStore } from "./actions.js";

const denied = (): ActionResult<never> => ({ ok: false, error: "fenced", message: "External action blocked; contact purpose is unavailable in this work scope" });
const missing = (): ActionResult<never> => ({ ok: false, error: "not-found", message: "Action not found in this work scope" });
const unavailable = (): ActionResult<never> => ({ ok: false, error: "unavailable", message: "Canonical work action authority unavailable; no dispatch permitted" });
const allowed = new Set(["submit", "inspect", "claim", "dispatch", "finish"]);

/** A view of the existing canonical authority, never an independent ledger or recipient namespace. */
export function workActionRequest(store: ActionStore, scope: string, operation: string, input: unknown): ActionResult<unknown> {
  if (!/^[a-z][a-z0-9:._-]{0,199}$/.test(scope) || !input || typeof input !== "object" || Array.isArray(input) || "owner" in input || "scope" in input) return { ok: false, error: "invalid-input", message: "Invalid work action request" };
  if (!allowed.has(operation)) return denied();
  const data = input as Record<string, any>;
  const owns = (id: unknown) => typeof id === "string" && !!store.db.query("SELECT 1 FROM external_action_scopes WHERE owner=? AND scope=? AND action_id=?").get(store.owner, scope, id);
  const projection = (action: ActionRecord): ActionRecord => {
    const row = store.db.query("SELECT recipients FROM external_action_scopes WHERE owner=? AND scope=? AND action_id=?").get(store.owner, scope, action.id) as { recipients: string };
    return { ...action, recipients: JSON.parse(row.recipients) };
  };
  const filter = (result: ActionResult<any>): ActionResult<unknown> => {
    if (!result.ok) {
      if (result.action && !owns(result.action.id)) return denied();
      if (result.error === "unavailable") return unavailable();
      return result.action ? { ...result, action: projection(result.action) } : result;
    }
    const action: ActionRecord | undefined = operation === "submit" ? result.value.action : ["inspect", "finish"].includes(operation) ? result.value : undefined;
    if (action && !owns(action.id)) return denied();
    if (operation === "submit" && action?.state === "held") return denied();
    if (!action) return result;
    return { ok: true, value: operation === "submit" ? { ...result.value, action: projection(action) } : projection(action) };
  };
  try {
    return store.db.transaction(() => {
      if (operation === "submit") {
        if (typeof data.requestId !== "string" || typeof data.threadId !== "string") return { ok: false as const, error: "invalid-input" as const, message: "Work submission needs request and thread identities" };
        const bound: ActionInput = { ...data, requestId: createHash("sha256").update(`${scope}:${data.requestId}`).digest("hex"), threadId: `${scope}:${data.threadId}` } as ActionInput;
        const result = store.submit(bound);
        if (result.ok && result.value.disposition === "created") store.db.query("INSERT INTO external_action_scopes(owner,scope,action_id,recipients) VALUES(?,?,?,?)").run(store.owner, scope, result.value.action.id, JSON.stringify([...new Set(bound.recipients.map(canonicalRecipient))].sort()));
        return filter(result);
      }
      const id = operation === "dispatch" || operation === "finish" ? data.ticket?.id : data.id;
      if (!owns(id)) return operation === "inspect" ? missing() : denied();
      return filter(actionRequest(store, operation, data));
    }).immediate();
  } catch { return unavailable(); }
}
