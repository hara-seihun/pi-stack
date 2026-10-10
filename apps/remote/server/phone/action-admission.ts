import { type ActionAuthority, type ActionTicket, type ActionEvidence } from "kenan-memory/actions";
import type { CallBrief } from "./policy";

/** Request IDs identify delivery attempts; the purpose and recipient identify contact intent. */
export function phoneIntent(brief: CallBrief) {
  const { requestId: _request, followUpOf: _followup, ...payload } = brief;
  return { intentKey: `telephone:${brief.purpose.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")}`, recipients: [brief.to], transport: "telephone", payload, requestId: brief.requestId, threadId: "phone-service" };
}
export function reservePhoneAction(actions: ActionAuthority, brief: CallBrief, approval?: { actionId: string; callId: string; reconciledAt: number; reason: string }) {
  const prior = approval ? actions.inspect(approval.actionId) : undefined;
  if (prior && !prior.ok) return prior;
  const submitted = approval && prior?.ok
    ? actions.followup(prior.value.id, prior.value.revision, phoneIntent(brief), { kind: "operator-observation", reference: approval.callId, detail: `Reconciled at ${approval.reconciledAt}: ${approval.reason}` })
    : actions.submit(phoneIntent(brief));
  if (!submitted.ok) return submitted;
  const { action, disposition } = submitted.value;
  if (disposition === "recipient-held" || action.state !== "accepted") return { ok: false as const, error: "action-already-owned" as const, message: "Contact already has a durable action; inspect/reconcile it rather than redial", action };
  const claim = actions.claim(action.id, "phone-service");
  return claim.ok ? { ok: true as const, value: claim.value } : claim;
}
export function settlePhoneAction(actions: ActionAuthority, ticket: ActionTicket, callId: string, dial: "none" | "dispatching" | "accepted" | "uncertain" | "rejected", providerId: string | null) {
  const result = { callId, providerId, dialState: dial };
  const evidence: ActionEvidence = { kind: dial === "accepted" ? "provider-receipt" : dial === "none" || dial === "rejected" ? "provider-rejection" : "operator-observation", reference: providerId ?? callId, detail: dial === "accepted" ? "Provider accepted telephone dial; purpose remains unresolved" : dial === "none" ? "Phone owner confirms provider dial was never dispatched" : dial === "rejected" ? "Transport affirmatively rejected before accepting dial" : "Telephone dispatch result uncertain; no replay authorized" };
  return actions.finish(ticket, dial === "accepted" ? "succeeded" : dial === "none" || dial === "rejected" ? "failed-before-effect" : "uncertain", result, evidence);
}
