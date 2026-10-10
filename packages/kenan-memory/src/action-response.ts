import type { ActionRecord, ActionResult } from "./actions.js";
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function finiteJson(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => finiteJson(item, depth + 1));
  return !!value && typeof value === "object" && Object.values(value).every(item => finiteJson(item, depth + 1));
}
export function validActionRecord(value: unknown): value is ActionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const evidence = row.evidence as Record<string, unknown> | null;
  return nonempty(row.id) && nonempty(row.owner) && nonempty(row.intentKey) && nonempty(row.transport)
    && Array.isArray(row.recipients) && row.recipients.length > 0 && row.recipients.every(nonempty)
    && ["accepted", "inflight", "succeeded", "failed-before-effect", "uncertain", "held"].includes(String(row.state))
    && integer(row.revision) && row.revision > 0 && integer(row.createdAt) && integer(row.updatedAt) && typeof row.resolved === "boolean"
    && finiteJson(row.payload) && finiteJson(row.result)
    && (evidence === null || !!evidence && ["provider-receipt", "provider-rejection", "operator-observation"].includes(String(evidence.kind)) && nonempty(evidence.reference) && nonempty(evidence.detail));
}
export function validActionResponse(operation: string, value: unknown): value is ActionResult<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, any>;
  if (result.ok === false) return ["invalid-input", "payload-conflict", "not-found", "fenced", "unavailable"].includes(result.error) && typeof result.message === "string" && (result.action === undefined || validActionRecord(result.action));
  if (result.ok !== true || !("value" in result)) return false;
  switch (operation) {
    case "submit": case "followup": return !!result.value && ["created", "existing", "recipient-held"].includes(result.value.disposition) && validActionRecord(result.value.action);
    case "inspect": case "finish": case "reconcile": case "recover": case "retry": return validActionRecord(result.value);
    case "list": return Array.isArray(result.value) && result.value.every(validActionRecord);
    case "claim": return !!result.value && nonempty(result.value.id) && nonempty(result.value.token) && integer(result.value.revision) && result.value.revision > 0;
    case "dispatch": case "hold-recipient": case "release-recipient": case "link-recipients": return result.value === null;
    default: return false;
  }
}
