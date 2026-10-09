import { Type, type Static, type TLiteral, type TUnion } from "typebox";

const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S" });
const id = Type.String({ minLength: 1, maxLength: 200, pattern: "^[a-zA-Z0-9_.:/-]+$" });
const time = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$" });
const nullableText = Type.Union([text, Type.Null()]);
const ids = Type.Array(id, { maxItems: 100, uniqueItems: true });
const texts = Type.Array(text, { maxItems: 100 });
const enumeration = <const T extends [string, ...string[]]>(values: T): TUnion<{ [K in keyof T]: TLiteral<T[K]> }> => Type.Union(values.map(value => Type.Literal(value))) as TUnion<{ [K in keyof T]: TLiteral<T[K]> }>;
export const LifeTargetSchema = Type.Union([
  Type.Object({ scope: Type.Literal("self") }, closed),
  Type.Object({ scope: Type.Literal("person"), person: id }, closed),
  Type.Object({ scope: Type.Literal("root") }, closed),
]);
export const LifeDueSchema = Type.Union([Type.Null(), Type.Object({ at: time, timeZone: text }, closed)]);
export const LifeEvidenceSchema = Type.Object({ kind: enumeration(["memory", "calendar", "question", "thread", "receipt", "source", "life"]), id, relation: nullableText }, closed);
export const LifeProvenanceSchema = Type.Object({
  factClass: enumeration(["stated", "revealed", "derived", "hypothesis"]),
  confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  source: Type.Object({ actor: nullableText, locator: nullableText, observedAt: time }, closed),
  evidence: Type.Array(LifeEvidenceSchema, { maxItems: 100 }), counterevidence: Type.Array(LifeEvidenceSchema, { maxItems: 100 }),
  validFrom: Type.Union([time, Type.Null()]), validUntil: Type.Union([time, Type.Null()]),
}, closed);
const common = { title: text, provenance: LifeProvenanceSchema };
export const LifeEntitySchema = Type.Union([
  Type.Object({ ...common, kind: Type.Literal("goal"), state: enumeration(["active", "paused", "achieved", "withdrawn"]), outcome: text, horizon: LifeDueSchema, tradeoffs: texts, commitments: ids }, closed),
  Type.Object({ ...common, kind: Type.Literal("commitment"), state: enumeration(["proposed", "ready", "running", "waiting", "completed", "cancelled"]), parties: ids, authority: nullableText, origin: text, due: LifeDueSchema, acceptance: text, dependencies: ids,
    owner: Type.Union([Type.Object({ kind: Type.Literal("kenan") }, closed), Type.Object({ kind: Type.Literal("person"), person: id }, closed)]), nextAction: nullableText,
    waiting: Type.Union([Type.Null(), Type.Object({ for: enumeration(["person", "dependency", "external"]), detail: text }, closed)]), goalId: Type.Union([id, Type.Null()]) }, closed),
  Type.Object({ ...common, kind: Type.Literal("needs-you"), state: enumeration(["open", "answered", "dismissed", "resolved"]), reason: enumeration(["decision", "missing-fact", "person-only-action"]), consequence: nullableText, recommendation: nullableText, requiredBy: LifeDueSchema, commitmentId: Type.Union([id, Type.Null()]), questionId: Type.Union([id, Type.Null()]) }, closed),
  Type.Object({ ...common, kind: Type.Literal("preference"), context: text, claim: text, options: texts, constraints: texts, agentExposure: nullableText, adoptedRule: Type.Boolean() }, closed),
]);
export const LifePolicySchema = Type.Object({
  status: enumeration(["active", "revoked"]), domains: texts, delegation: text, financialDiscretion: nullableText,
  steering: Type.Object({ mode: enumeration(["off", "visible", "silent-permitted"]), instruction: nullableText }, closed),
  exclusions: texts, disclosure: text,
  consent: Type.Object({ thirdParty: text, immediateOverride: nullableText }, closed),
  protectedSkills: texts, reviewAt: LifeDueSchema, provenance: LifeProvenanceSchema,
}, closed);
export const LifeCoverageSchema = Type.Object({
  source: id, state: enumeration(["complete", "partial", "inaccessible", "excluded"]),
  checkedAt: Type.String({ ...time, description: "Last actual source check; may precede completion of reconciliation or follow a retained earlier reconciliation." }),
  reconciledAt: Type.Union([time, Type.Null()], { description: "Last actual reconciliation completion, or null when none is recorded. Reading alone does not reconcile." }),
  freshUntil: Type.Union([time, Type.Null()], { description: "Recorded source freshness boundary, or null when freshness is unknown; null does not assert perpetual freshness." }),
  detail: nullableText, error: nullableText, evidence: Type.Array(LifeEvidenceSchema, { maxItems: 100 }),
}, closed);
export const LifeSteeringSchema = Type.Object({
  policyRevision: Type.Integer({ minimum: 1 }), goalIds: ids, preferenceIds: ids,
  evidence: Type.Array(LifeEvidenceSchema, { maxItems: 100 }), action: text, rationale: text,
  visibility: enumeration(["visible", "silent"]), state: enumeration(["planned", "executing", "succeeded", "failed", "uncertain"]),
  outcome: nullableText, receipt: Type.Union([LifeEvidenceSchema, Type.Null()]), compensation: nullableText,
}, closed);
const target = { target: LifeTargetSchema };
const cas = { expectedRevision: Type.Integer({ minimum: 0 }) };
export const LifeReadRequestSchema = Type.Object({ operation: Type.Literal("read"), ...target }, closed);
export const LifePolicyRequestSchema = Type.Union([
  Type.Object({ operation: Type.Literal("policy-read"), ...target, includeHistory: Type.Boolean() }, closed),
  Type.Object({ operation: Type.Literal("policy-write"), ...target, ...cas, policy: LifePolicySchema }, closed),
]);
export const LifeSteeringRequestSchema = Type.Union([
  Type.Object({ operation: Type.Literal("steering-read"), ...target, limit: Type.Integer({ minimum: 1, maximum: 100 }) }, closed),
  Type.Object({ operation: Type.Literal("steering-write"), ...target, ...cas, id, steering: LifeSteeringSchema }, closed),
]);
export const LifeWriteRequestSchema = Type.Union([
  Type.Object({ operation: Type.Literal("put-entity"), ...target, ...cas, id, entity: LifeEntitySchema }, closed),
  Type.Object({ operation: Type.Literal("retract-entity"), ...target, ...cas, id, reason: text }, closed),
  Type.Object({ operation: Type.Literal("coverage-write"), ...target, ...cas, coverage: LifeCoverageSchema }, closed),
  Type.Object({ operation: Type.Literal("import-entities"), ...target, source: text, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), entries: Type.Array(Type.Object({ id, entity: LifeEntitySchema }, closed), { maxItems: 1000 }) }, closed),
]);
export const LifeRequestSchema = Type.Union([
  LifeReadRequestSchema, LifePolicyRequestSchema, LifeSteeringRequestSchema, LifeWriteRequestSchema,
  Type.Object({ operation: Type.Literal("entity-history"), ...target, id }, closed),
  Type.Object({ operation: Type.Literal("import-receipt"), ...target, source: text }, closed),
]);
export type LifeTarget = Static<typeof LifeTargetSchema>;
export type LifeDue = Static<typeof LifeDueSchema>;
export type LifeProvenance = Static<typeof LifeProvenanceSchema>;
export type LifeEntityInput = Static<typeof LifeEntitySchema>;
export type LifePolicyInput = Static<typeof LifePolicySchema>;
export type LifeCoverageInput = Static<typeof LifeCoverageSchema>;
export type LifeSteeringInput = Static<typeof LifeSteeringSchema>;
export type LifeRequest = Static<typeof LifeRequestSchema>;
export type LifeVersion<T> = { id: string; revision: number; recordedAt: string; recordedBy: string; threadId: string | null; value: T };
export type LifeEntity = LifeVersion<LifeEntityInput> & { status: "current" | "superseded" | "retracted"; supersededBy: number | null; retractionReason: string | null };
export type LifePolicy = LifeVersion<LifePolicyInput>;
export type LifeCoverage = LifeVersion<LifeCoverageInput>;
export type LifeSteering = LifeVersion<LifeSteeringInput>;
export type LifeSnapshot = { subject: string; entities: LifeEntity[]; coverage: LifeCoverage[] };
export type LifePolicyView = { subject: string; current: LifePolicy | null; history: LifePolicy[] };
export type LifeImportReceipt = { source: string; fingerprint: string; importedAt: string; ids: string[]; status: "imported" | "already-imported" };
export type LifeValue = LifeSnapshot | LifePolicyView | LifeEntity | LifeEntity[] | LifePolicy | LifeCoverage | LifeSteering | LifeSteering[] | LifeImportReceipt;
export type LifeError = "disabled" | "unauthenticated" | "invalid-request" | "unavailable" | "conflict" | "not-found";
export type LifeResult<T = LifeValue> = { ok: true; value: T } | { ok: false; error: LifeError; message: string; currentRevision?: number };
export interface LifeClient { request<T = LifeValue>(request: LifeRequest): Promise<LifeResult<T>> }
export const LIFE_ROOT_SUBJECT = "root:kenan";
export const LIFE_TOOL_NAMES = ["life_read", "life_write", "life_policy", "life_steering"];
