import { createHash } from "node:crypto";

export const ROOT_CONSENT_HEADER = "x-pi-kenan-consent";
export const CONSENT_PREFIX = "/v1/root-consent/";
export const consentIdValid = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export function consentInboxId(consentId: string): string {
  const hex = createHash("sha256").update(`kenan-consent-inbox:${consentId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export interface ConsentQuestion { consentId: string; subject: string; text: string }
export interface ConsentQuestionReceipt { threadId: string; questionId: string }
export interface ConsentAnswerQuery { consentId: string; subject: string; threadId: string; questionId: string }
export interface ConsentAnswerReceipt { question: string; answer?: { text: string; selectedSuggestions: string[]; dismissed: boolean; acceptedAt: number } }
export interface ConsentReply { consentId: string; person: string; threadId: string; reply: string }
export type ConsentResult<T> = { ok: true; value: T } | { ok: false; message: string };
export interface ConsentBridge {
  question(input: ConsentQuestion): Promise<ConsentResult<ConsentQuestionReceipt>>;
  answer(input: ConsentAnswerQuery): Promise<ConsentResult<ConsentAnswerReceipt>>;
  reply(input: ConsentReply): Promise<ConsentResult<{ accepted: true }>>;
}
