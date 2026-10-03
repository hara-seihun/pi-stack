import type { DisclosureInput, MemoryInput, MemoryRequest, MemorySetting, ReadContext } from "./contract.js";
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 100_000;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(text);
const date = (v: unknown) => v === undefined || typeof v === "string" && Number.isFinite(Date.parse(v));
const limit = (v: unknown) => v === undefined || Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 100;
function setting(v: unknown): MemorySetting | undefined {
  return object(v) && text(v.person) && (v.threadId === undefined || text(v.threadId)) && (v.roomId === undefined || text(v.roomId))
    ? { person: v.person, ...(v.threadId ? { threadId: v.threadId } : {}), ...(v.roomId ? { roomId: v.roomId } : {}) } : undefined;
}
function context(v: unknown): ReadContext | undefined {
  return object(v) && text(v.threadId) && text(v.turnId) && (v.roomId === undefined || text(v.roomId))
    ? { threadId: v.threadId, turnId: v.turnId, ...(v.roomId ? { roomId: v.roomId } : {}) } : undefined;
}
export function validateRequest(v: unknown): MemoryRequest | undefined {
  if (!object(v)) return;
  if (v.operation === "write") {
    const i = v.item, s = setting(i?.setting), source = i?.source;
    if (!object(i) || !s || !text(i.text) || !strings(i.about) || !object(source) || typeof i.obviouslyPrivate !== "boolean" || !date(i.occurredAt)) return;
    if (!text(source.saidBy) && !text(source.actedFor)) return;
    if (["saidBy", "actedFor", "action", "externalId"].some(key => source[key] !== undefined && !text(source[key]))) return;
    const item: MemoryInput = { text: i.text, about: i.about, setting: s, obviouslyPrivate: i.obviouslyPrivate,
      source: Object.fromEntries(["saidBy", "actedFor", "action", "externalId"].filter(key => source[key] !== undefined).map(key => [key, source[key]])),
      ...(i.occurredAt ? { occurredAt: i.occurredAt } : {}) };
    return { operation: "write", item };
  }
  if (v.operation === "log-disclosure") {
    const d = v.disclosure, s = setting(d?.setting);
    if (!object(d) || !s || !text(d.text) || !strings(d.about) || !strings(d.to) || !date(d.occurredAt) || d.memoryIds !== undefined && !strings(d.memoryIds)) return;
    const disclosure: DisclosureInput = { text: d.text, about: d.about, to: d.to, setting: s,
      ...(d.memoryIds ? { memoryIds: d.memoryIds } : {}), ...(d.occurredAt ? { occurredAt: d.occurredAt } : {}) };
    return { operation: "log-disclosure", disclosure };
  }
  if (v.operation === "forget") return strings(v.ids) && ["delete", "stop-using"].includes(v.mode) ? { operation: "forget", ids: v.ids, mode: v.mode } : undefined;
  const c = context(v.context);
  if (!c) return;
  if (v.operation === "finalize-turn") return typeof v.reply === "string" && v.reply.length <= 100_000 ? { operation: "finalize-turn", context: c, reply: v.reply } : undefined;
  if (v.operation === "read") return strings(v.ids) ? { operation: "read", ids: v.ids, context: c } : undefined;
  if (v.operation === "disclosures") return limit(v.limit) ? { operation: "disclosures", context: c, limit: v.limit } : undefined;
  if (v.operation === "search" && typeof v.query === "string" && v.query.length <= 10_000 && limit(v.limit) && (v.about === undefined || strings(v.about)))
    return { operation: "search", query: v.query, about: v.about, limit: v.limit, context: c };
}
