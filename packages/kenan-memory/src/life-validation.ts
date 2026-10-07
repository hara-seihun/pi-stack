import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { LifeRequestSchema, LifeEntitySchema, LifePolicySchema, LifeCoverageSchema, LifeSteeringSchema, type LifeRequest, type LifeResult } from "./life-contract.js";

const timestampFields = new Set(["at", "observedAt", "validFrom", "validUntil", "checkedAt", "reconciledAt", "freshUntil", "recordedAt", "importedAt"]);
function semantic(value: unknown, field: string | null = null): boolean {
  if (typeof value === "string" && field !== null && timestampFields.has(field)) {
    const local = value.slice(0, 19);
    if (!Number.isFinite(Date.parse(value)) || !Number.isFinite(Date.parse(`${local}Z`))) return false;
    if (new Date(`${local}Z`).toISOString().slice(0, 19) !== local) return false;
  }
  if (Array.isArray(value)) return value.every(item => semantic(item));
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if ("timeZone" in item) {
      try { new Intl.DateTimeFormat("en", { timeZone: item.timeZone as string }); } catch { return false; }
    }
    if (typeof item.validFrom === "string" && typeof item.validUntil === "string" && Date.parse(item.validUntil) <= Date.parse(item.validFrom)) return false;
    if (item.kind === "commitment" && ((item.state === "waiting") !== (item.waiting !== null))) return false;
    if (item.kind === "preference" && item.adoptedRule === true && (item.provenance as { factClass: string }).factClass !== "stated") return false;
    if (item.state === "complete" && "reconciledAt" in item && (item.reconciledAt === null || item.error !== null)) return false;
    if (typeof item.reconciledAt === "string" && typeof item.checkedAt === "string" && Date.parse(item.reconciledAt) > Date.parse(item.checkedAt)) return false;
    if (item.mode === "off" && item.instruction !== null) return false;
    return Object.entries(item).every(([key, entry]) => semantic(entry, key));
  }
  return true;
}
const closed = { additionalProperties: false };
const metadata = { id: Type.String(), revision: Type.Integer({ minimum: 1 }), recordedAt: Type.String(), recordedBy: Type.String(), threadId: Type.Union([Type.String(), Type.Null()]) };
const entity = Type.Object({ ...metadata, value: LifeEntitySchema, status: Type.Union([Type.Literal("current"), Type.Literal("superseded"), Type.Literal("retracted")]), supersededBy: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), retractionReason: Type.Union([Type.String(), Type.Null()]) }, closed);
const policy = Type.Object({ ...metadata, value: LifePolicySchema }, closed);
const coverage = Type.Object({ ...metadata, value: LifeCoverageSchema }, closed);
const steering = Type.Object({ ...metadata, value: LifeSteeringSchema }, closed);
const receipt = Type.Object({ source: Type.String(), fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), importedAt: Type.String(), ids: Type.Array(Type.String()), status: Type.Union([Type.Literal("imported"), Type.Literal("already-imported")]) }, closed);
const responses: Record<LifeRequest["operation"], TSchema> = {
  read: Type.Object({ subject: Type.String(), entities: Type.Array(entity), coverage: Type.Array(coverage) }, closed),
  "entity-history": Type.Array(entity), "put-entity": entity, "retract-entity": entity,
  "policy-read": Type.Object({ subject: Type.String(), current: Type.Union([policy, Type.Null()]), history: Type.Array(policy) }, closed),
  "policy-write": policy, "coverage-write": coverage, "steering-read": Type.Array(steering), "steering-write": steering,
  "import-receipt": receipt, "import-entities": receipt,
};
const failure = Type.Object({ ok: Type.Literal(false), error: Type.Union([Type.Literal("disabled"), Type.Literal("unauthenticated"), Type.Literal("invalid-request"), Type.Literal("unavailable"), Type.Literal("conflict"), Type.Literal("not-found")]), message: Type.String(), currentRevision: Type.Optional(Type.Integer({ minimum: 0 })) }, closed);
export function validateLifeResponse<T>(input: unknown, request: LifeRequest): LifeResult<T> | null {
  const schema = Type.Union([Type.Object({ ok: Type.Literal(true), value: responses[request.operation] }, closed), failure]);
  return Value.Check(schema, input) && semantic(input) ? input as LifeResult<T> : null;
}
export function validateLifeRequest(input: unknown): LifeResult<LifeRequest> {
  if (!Value.Check(LifeRequestSchema, input) || !semantic(input)) return { ok: false, error: "invalid-request", message: "Invalid life operation, fields or temporal state" };
  return { ok: true, value: input as LifeRequest };
}
