import type { DisclosureInput, MemoryError, MemoryInput, MemoryRequest, MemoryResult, MemorySetting, MemorySource, ReadContext } from "./contract.js";
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const memoryErrors = { disabled: true, unauthenticated: true, "invalid-request": true, unavailable: true, "not-found": true, conflict: true } satisfies Record<MemoryError, true>;
export function validateResult<T>(value: unknown): MemoryResult<T> | undefined {
  if (!object(value)) return undefined;
  if (value.ok === true && Object.hasOwn(value, "value") && !Object.hasOwn(value, "error")) return { ok: true, value: value.value };
  if (value.ok === false && !Object.hasOwn(value, "value") && typeof value.error === "string" && Object.hasOwn(memoryErrors, value.error) && typeof value.message === "string")
    return { ok: false, error: value.error as MemoryError, message: value.message };
  return undefined;
}
/** A request either validates to a typed operation or names the first field that breaks the contract. */
export type RequestValidation = { ok: true; request: MemoryRequest } | { ok: false; reason: string };
type Field<T> = { ok: true; value: T } | { ok: false; reason: string };
export const MEMORY_OPERATIONS = ["search", "read", "write", "forget", "disclosures", "log-disclosure", "finalize-turn", "data"] as const satisfies readonly MemoryRequest["operation"][];
const SOURCE_KEYS = ["saidBy", "actedFor", "action", "externalId"] as const;
const TEXT = "a non-blank string of at most 100000 characters";
const STRINGS = "a non-empty array of at most 100 non-blank strings";
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 100_000;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(text);
const date = (v: unknown) => v === undefined || typeof v === "string" && Number.isFinite(Date.parse(v));
const limit = (v: unknown) => v === undefined || Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 100;
const reject = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const accept = (request: MemoryRequest): RequestValidation => ({ ok: true, request });
const DATE_REASON = (name: string) => `${name} must be an ISO 8601 date-time string when present`;
function setting(v: unknown): Field<MemorySetting> {
  if (!object(v) || !text(v.person)) return reject(`setting.person must be ${TEXT}`);
  for (const key of ["threadId", "roomId"] as const) if (v[key] !== undefined && !text(v[key])) return reject(`setting.${key} must be ${TEXT} when present`);
  return { ok: true, value: { person: v.person, ...(v.threadId ? { threadId: v.threadId } : {}), ...(v.roomId ? { roomId: v.roomId } : {}) } };
}
function context(v: unknown): Field<ReadContext> {
  if (!object(v)) return reject("context must be an object with threadId and turnId");
  for (const key of ["threadId", "turnId"] as const) if (!text(v[key])) return reject(`context.${key} must be ${TEXT}`);
  if (v.roomId !== undefined && !text(v.roomId)) return reject(`context.roomId must be ${TEXT} when present`);
  return { ok: true, value: { threadId: v.threadId, turnId: v.turnId, ...(v.roomId ? { roomId: v.roomId } : {}) } };
}
function source(v: unknown): Field<MemorySource> {
  if (!object(v)) return reject("source must be an object that includes saidBy or actedFor");
  for (const key of SOURCE_KEYS) if (v[key] !== undefined && !text(v[key])) return reject(`source.${key} must be ${TEXT} when present`);
  const detail = { ...(v.action !== undefined ? { action: v.action as string } : {}), ...(v.externalId !== undefined ? { externalId: v.externalId as string } : {}) };
  if (v.saidBy !== undefined) return { ok: true, value: { saidBy: v.saidBy, ...(v.actedFor !== undefined ? { actedFor: v.actedFor } : {}), ...detail } };
  if (v.actedFor !== undefined) return { ok: true, value: { actedFor: v.actedFor, ...detail } };
  return reject("source needs saidBy or actedFor: saidBy is the person who said it; actedFor is the person an action was taken for (action records use actedFor with action and externalId)");
}
export function validateRequest(v: unknown): RequestValidation {
  if (!object(v)) return reject("request must be a JSON object");
  if (v.operation === "write") {
    const i = v.item;
    if (!object(i)) return reject("item must be an object");
    const s = setting(i.setting);
    if (!s.ok) return s;
    if (!text(i.text)) return reject(`text must be ${TEXT}`);
    if (!strings(i.about)) return reject(`about must be ${STRINGS}`);
    const src = source(i.source);
    if (!src.ok) return src;
    if (typeof i.obviouslyPrivate !== "boolean") return reject("obviouslyPrivate must be a boolean");
    if (!date(i.occurredAt)) return reject(DATE_REASON("occurredAt"));
    const item: MemoryInput = { text: i.text, about: i.about, setting: s.value, obviouslyPrivate: i.obviouslyPrivate, source: src.value,
      ...(i.occurredAt ? { occurredAt: i.occurredAt } : {}) };
    return accept({ operation: "write", item });
  }
  if (v.operation === "log-disclosure") {
    const d = v.disclosure;
    if (!object(d)) return reject("disclosure must be an object");
    const s = setting(d.setting);
    if (!s.ok) return s;
    if (!text(d.text)) return reject(`text must be ${TEXT}`);
    if (!strings(d.about)) return reject(`about must be ${STRINGS}`);
    if (!strings(d.to)) return reject(`to must be ${STRINGS}`);
    if (d.memoryIds !== undefined && !strings(d.memoryIds)) return reject(`memoryIds must be ${STRINGS} when present`);
    if (!date(d.occurredAt)) return reject(DATE_REASON("occurredAt"));
    const disclosure: DisclosureInput = { text: d.text, about: d.about, to: d.to, setting: s.value,
      ...(d.memoryIds ? { memoryIds: d.memoryIds } : {}), ...(d.occurredAt ? { occurredAt: d.occurredAt } : {}) };
    return accept({ operation: "log-disclosure", disclosure });
  }
  if (v.operation === "forget") {
    if (!strings(v.ids)) return reject(`ids must be ${STRINGS}`);
    if (v.mode !== "delete" && v.mode !== "stop-using") return reject("mode must be \"delete\" or \"stop-using\"");
    return accept({ operation: "forget", ids: v.ids, mode: v.mode });
  }
  if (!MEMORY_OPERATIONS.includes(v.operation)) return reject(`operation must be one of ${MEMORY_OPERATIONS.join(", ")}`);
  const c = context(v.context);
  if (!c.ok) return c;
  if (v.operation === "data") {
    if (!text(v.dataset) || !text(v.requestId) || !Object.hasOwn(v, "command")) return reject("Structured memory data requires explicit dataset, requestId and command");
    return accept({ operation: "data", dataset: v.dataset, requestId: v.requestId, command: v.command, context: c.value });
  }
  if (v.operation === "finalize-turn") {
    if (typeof v.reply !== "string" || v.reply.length > 100_000) return reject("reply must be a string of at most 100000 characters");
    return accept({ operation: "finalize-turn", context: c.value, reply: v.reply });
  }
  if (v.operation === "read") return strings(v.ids) ? accept({ operation: "read", ids: v.ids, context: c.value }) : reject(`ids must be ${STRINGS}`);
  if (v.operation === "disclosures") {
    if (!limit(v.limit)) return reject("limit must be an integer from 1 to 100 when present");
    if (v.about !== undefined && !text(v.about)) return reject(`about must be ${TEXT} when present`);
    return accept({ operation: "disclosures", context: c.value, limit: v.limit, about: v.about });
  }
  if (typeof v.query !== "string" || v.query.length > 10_000) return reject("query must be a string of at most 10000 characters");
  if (!limit(v.limit)) return reject("limit must be an integer from 1 to 100 when present");
  if (v.about !== undefined && !strings(v.about)) return reject(`about must be ${STRINGS} when present`);
  return accept({ operation: "search", query: v.query, about: v.about, limit: v.limit, context: c.value });
}
