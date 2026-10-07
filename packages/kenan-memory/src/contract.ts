import { stateValue } from "./explicit-state.js";

export type PersonId = string;
export type MemoryRole = "person" | "root";
export type ForgetMode = "delete" | "stop-using";
export type MemorySetting = { person: PersonId; threadId?: string; roomId?: string };
export interface MemoryInput {
  text: string;
  about: PersonId[];
  source: { saidBy?: PersonId; actedFor?: PersonId; action?: string; externalId?: string };
  setting: MemorySetting;
  occurredAt?: string;
  obviouslyPrivate: boolean;
}
export interface MemoryItem extends MemoryInput {
  id: string;
  occurredAt: string;
  recordedAt: string;
  recordedBy: PersonId;
  stoppedAt?: string;
}
export interface DisclosureInput {
  text: string;
  about: PersonId[];
  to: PersonId[];
  memoryIds?: string[];
  setting: MemorySetting;
  occurredAt?: string;
}
export interface Disclosure extends DisclosureInput {
  id: string;
  occurredAt: string;
  recordedBy: PersonId;
  kind?: "explicit" | "memory-read" | "root-reply" | "consent-question" | "consent-answer" | "root-notification" | "root-request-status";
  consentId?: string;
  consentSubject?: PersonId;
  rootSessionId?: string;
  turnId?: string;
  finalReply?: string;
  finalizedAt?: string;
}
export interface ReadContext { threadId: string; turnId: string; roomId?: string }
export interface MemoryReadReport extends ReadContext {
  person: PersonId;
  touchedOtherPeople: boolean;
  about: PersonId[];
}
export interface MemoryRead<T> { value: T; readReport: MemoryReadReport }
export type MemoryRequest =
  | { operation: "write"; item: MemoryInput }
  | { operation: "search"; query: string; about?: PersonId[]; limit?: number; context: ReadContext }
  | { operation: "read"; ids: string[]; context: ReadContext }
  | { operation: "forget"; ids: string[]; mode: ForgetMode }
  | { operation: "log-disclosure"; disclosure: DisclosureInput }
  | { operation: "disclosures"; context: ReadContext; limit?: number; about?: PersonId }
  | { operation: "finalize-turn"; context: ReadContext; reply: string }; 
export type MemoryValue = { finalized: string[] } | { id: string; forgotten: true } | MemoryItem | MemoryRead<MemoryItem[]> | Disclosure | MemoryRead<Disclosure[]> | { forgotten: string[]; mode: ForgetMode };
export type MemoryError = "disabled" | "unauthenticated" | "invalid-request" | "unavailable";
export type MemoryResult<T = MemoryValue> = { ok: true; value: T } | { ok: false; error: MemoryError; message: string };
/** person comes from the verified connection, never the request body. */
export interface MemoryClient { request<T = MemoryValue>(request: MemoryRequest): Promise<MemoryResult<T>> }
export const MEMORY_READ_DETAIL = "kenanMemoryRead";
export const MEMORY_DEFAULT_PORT = 18820;
export const MEMORY_TOKEN_HEADER = "x-kenan-memory-session";
/** A shared-UID runner uses a supervisor-issued session credential, not a claimed person name. */
export interface MemorySession { person: PersonId; threadId: string; token: string; role: MemoryRole }
export interface RootAdmission {
  person: PersonId;
  threadId: string;
  rootSessionId: string;
  recipients: PersonId[];
  subjects: PersonId[];
  roomId?: string;
  memoryToken: string;
}
export interface RootAdmitRequest { callerToken: string; request: string; rootSessionId?: string }
export interface RootResumeConsent {
  rootSessionId: string;
  subject: PersonId;
  question: string;
  answer: string;
  consentId: string;
}
export interface RootLogConsent {
  rootSessionId: string;
  consentId: string;
  subject: PersonId;
  kind: "question" | "answer";
  text: string;
}
export interface RootLogNotification {
  rootSessionId: string;
  notificationId: string;
  recipient: PersonId;
  text: string;
  subjects: PersonId[];
  obviouslyPrivate: boolean;
}
export const KENAN_REQUEST_HEADER = "x-kenan-request-id";
export const KENAN_REQUEST_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export type KenanRequestStatus = "pending" | "failed" | "interrupted";
export interface RootLogRequestStatus { rootSessionId: string; requestId: string; status: "failed" | "interrupted" }
const requestNoticeStates = { failed: "failed", interrupted: "was interrupted" } satisfies Record<RootLogRequestStatus["status"], string>;
export const kenanRequestNotice = (requestId: string, status: RootLogRequestStatus["status"]) => `Kenan's request ${requestId} ${stateValue(requestNoticeStates, status)} before completion. Actions may already have occurred; do not repeat the original request. Its status can be retrieved with ask_kenan({requestId:\"${requestId}\"}).`;
export const KENAN_REQUEST_QUEUE_REASONS = ["global-agent-capacity", "root-concurrency", "admission-unavailable"] as const;
export type KenanRequestQueuedReason = typeof KENAN_REQUEST_QUEUE_REASONS[number];
export type KenanRequestResponse = { reply: string } | { requestId: string; status: "pending"; reason?: KenanRequestQueuedReason } | { requestId: string; status: "failed" | "interrupted" };
export interface RootFinalizeReply { rootSessionId: string; reply: string; subjects: PersonId[]; recipients?: PersonId[] }
export type RoomAudienceResolver = (person: PersonId, threadId: string) => { roomId: string; people: PersonId[] } | undefined | Promise<{ roomId: string; people: PersonId[] } | undefined>;
export const KENAN_ROOT_DEFAULT_PORT = 18821;
