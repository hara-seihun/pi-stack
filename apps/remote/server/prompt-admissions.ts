import type { Database } from "bun:sqlite";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Delivery, ThreadError } from "pi-orchestrator/api";
import { assertNever } from "../shared/explicit-state";

export type PromptInput = { requestId: string; text: string; delivery: Delivery; replyTo?: string; includeMeetingImages?: boolean };
export type PreparedPrompt = { text: string; delivery: Delivery; images: ImageContent[] };
export type PromptFailure = { code: ThreadError["code"] | "forbidden"; message: string };
export type AdmissionResult<T> = { ok: true; value: T } | { ok: false; error: PromptFailure };
export type PromptAdmissionResponse = {
  status: number;
  body: { outcome: "accepted"; accepted: true; workId: string; delivery: Delivery; effectiveDelivery?: Delivery }
    | { outcome: "pending" | "rejected"; error: string; code: string };
};
export type PromptAdmissionEffects = {
  prepare(input: PromptInput): Promise<AdmissionResult<PreparedPrompt>>;
  send(sessionId: string, requestId: string, prepared: PreparedPrompt): Promise<AdmissionResult<{ id: string; delivery: Delivery }>>;
};
type Receipt = { request_id: string; session_id: string; input: string; resolved: string | null; status: number | null; response: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const rejection = (code: string, error: string, status = 400): PromptAdmissionResponse => ({ status, body: { outcome: "rejected", code, error } });
const pending = (error: string): PromptAdmissionResponse => ({ status: 503, body: { outcome: "pending", code: "unavailable", error } });
function failureResponse(error: PromptFailure): PromptAdmissionResponse {
  switch (error.code) {
    case "invalid_request": return rejection(error.code, error.message);
    case "oversized": return rejection(error.code, error.message, 413);
    case "not_found": return rejection(error.code, error.message, 404);
    case "conflict": return rejection(error.code, error.message, 409);
    case "forbidden": return rejection(error.code, error.message, 403);
    case "unavailable":
    case "no_pending_messages":
    case "cancellation_failed": return pending(error.message);
  }
  return assertNever(error.code, "Prompt admission failure");
}
export function parsePromptInput(body: unknown): AdmissionResult<PromptInput> {
  if (!object(body) || typeof body.requestId !== "string" || !uuid.test(body.requestId)
    || typeof body.text !== "string" || !body.text.trim()
    || !["queue", "steer", "hardSteer"].includes(String(body.delivery))
    || body.replyTo !== undefined && (typeof body.replyTo !== "string" || !body.replyTo)
    || body.includeMeetingImages !== undefined && typeof body.includeMeetingImages !== "boolean"
    || Object.keys(body).some(key => !["requestId", "text", "delivery", "replyTo", "includeMeetingImages"].includes(key))) {
    return { ok: false, error: { code: "invalid_request", message: "Provide a valid requestId, nonempty prompt, explicit delivery and optional replyTo/includeMeetingImages." } };
  }
  return { ok: true, value: { requestId: body.requestId, text: body.text, delivery: body.delivery as Delivery,
    ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo as string }),
    ...(body.includeMeetingImages === undefined ? {} : { includeMeetingImages: body.includeMeetingImages as boolean }) } };
}

/** The resolved quote and meeting image bytes are immutable before admission to the thread owner. */
export class PromptAdmissions {
  private readonly inFlight = new Map<string, Promise<PromptAdmissionResponse>>();
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_admissions (
      request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input TEXT NOT NULL,
      resolved TEXT, status INTEGER, response TEXT,
      CHECK ((status IS NULL AND response IS NULL) OR (status IS NOT NULL AND response IS NOT NULL))
    )`);
  }
  private get(requestId: string): Receipt | null {
    return this.db.query("SELECT * FROM prompt_admissions WHERE request_id=?").get(requestId) as Receipt | null;
  }
  has(requestId: string): boolean { return this.get(requestId) !== null; }
  async submit(sessionId: string, body: unknown, effects: PromptAdmissionEffects): Promise<PromptAdmissionResponse> {
    const input = parsePromptInput(body);
    if (!input.ok) return failureResponse(input.error);
    if (!sessionId) return rejection("invalid_request", "A prompt recipient is required.");
    const serialized = JSON.stringify(input.value);
    try {
      this.db.query("INSERT OR IGNORE INTO prompt_admissions(request_id,session_id,input) VALUES(?,?,?)")
        .run(input.value.requestId, sessionId, serialized);
      const receipt = this.get(input.value.requestId)!;
      if (receipt.session_id !== sessionId || receipt.input !== serialized) return rejection("conflict", "requestId already belongs to different prompt input or recipient", 409);
      if (receipt.response !== null && receipt.status !== null) return { status: receipt.status, body: JSON.parse(receipt.response) };
      const previous = this.inFlight.get(input.value.requestId);
      if (previous) return previous;
      const operation = this.admit(receipt, input.value, effects).finally(() => this.inFlight.delete(input.value.requestId));
      this.inFlight.set(input.value.requestId, operation);
      return operation;
    } catch (error) { return pending(error instanceof Error ? error.message : String(error)); }
  }
  private terminal(requestId: string, response: PromptAdmissionResponse): PromptAdmissionResponse {
    this.db.query("UPDATE prompt_admissions SET status=?,response=? WHERE request_id=?")
      .run(response.status, JSON.stringify(response.body), requestId);
    return response;
  }
  private async admit(receipt: Receipt, input: PromptInput, effects: PromptAdmissionEffects): Promise<PromptAdmissionResponse> {
    try {
      let prepared: PreparedPrompt;
      if (receipt.resolved !== null) prepared = JSON.parse(receipt.resolved);
      else {
        const result = await effects.prepare(input);
        if (!result.ok) {
          const response = failureResponse(result.error);
          return response.body.outcome === "rejected" ? this.terminal(input.requestId, response) : response;
        }
        const serialized = JSON.stringify(result.value);
        this.db.query("UPDATE prompt_admissions SET resolved=? WHERE request_id=? AND resolved IS NULL")
          .run(serialized, input.requestId);
        prepared = JSON.parse(this.get(input.requestId)!.resolved!);
      }
      const sent = await effects.send(receipt.session_id, input.requestId, prepared);
      if (!sent.ok) {
        const response = failureResponse(sent.error);
        return response.body.outcome === "rejected" ? this.terminal(input.requestId, response) : response;
      }
      if (typeof sent.value.id !== "string" || !sent.value.id || !["queue", "steer", "hardSteer"].includes(sent.value.delivery)) return pending("The owner returned an invalid admission receipt; acceptance is unconfirmed.");
      return this.terminal(input.requestId, { status: 202, body: { outcome: "accepted", accepted: true, workId: sent.value.id, delivery: input.delivery,
        ...(sent.value.delivery !== input.delivery ? { effectiveDelivery: sent.value.delivery } : {}) } });
    } catch (error) { return pending(error instanceof Error ? error.message : String(error)); }
  }
}
