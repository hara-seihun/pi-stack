import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ThinkingLevel } from "./threads/contracts.js";

export const CompletionRequestIdSchema = Type.String({ pattern: "^(?!openapi\\.json$)[A-Za-z0-9._:-]{1,256}$" });
export const CompletionModelSchema = Type.Literal("luna");
export const CompletionThinkingLevelSchema = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
// The wire schema stays explicit for generated clients; this fails to compile if it ever drifts from the thread levels.
const thinkingLevelsMatch: Static<typeof CompletionThinkingLevelSchema> extends ThinkingLevel ? ThinkingLevel extends Static<typeof CompletionThinkingLevelSchema> ? true : never : never = true;
void thinkingLevelsMatch;
export const CompletionInputSchema = Type.Object({
  model: CompletionModelSchema,
  prompt: Type.String({ minLength: 1 }),
  systemPrompt: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(CompletionThinkingLevelSchema),
  speed: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("priority")])),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Reserved provider-native output cap. Codex Luna rejects this option with HTTP 422 unsupported-option; it is never silently ignored." })),
  responseFormat: Type.Optional(Type.Object({
    type: Type.Literal("json_schema"),
    name: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
    schema: Type.Record(Type.String(), Type.Unknown()),
    strict: Type.Optional(Type.Boolean({ default: true })),
  }, { additionalProperties: false })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
const tokens = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const CompletionUsageSchema = Type.Object({
  input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens, totalTokens: tokens,
  reasoning: Type.Optional(tokens),
}, { additionalProperties: false });
export const CompletionResultSchema = Type.Object({
  text: Type.String(), provider: Type.String(), model: Type.String(), responseId: Type.Optional(Type.String()),
  usage: CompletionUsageSchema,
  stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length")]),
}, { additionalProperties: false });
export const CompletionErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal("invalid-request"), Type.Literal("unsupported-option"), Type.Literal("not-found"),
    Type.Literal("request-conflict"), Type.Literal("invalid-state"), Type.Literal("provider"),
    Type.Literal("authentication"), Type.Literal("cancelled"), Type.Literal("indeterminate"),
    Type.Literal("missing-provider-evidence"), Type.Literal("transport"), Type.Literal("protocol"), Type.Literal("rate-limited"),
  ]),
  message: Type.String(),
  httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
const completed = { state: Type.Literal("completed"), result: CompletionResultSchema };
const failed = {
  state: Type.Union([Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("indeterminate")]),
  error: CompletionErrorSchema,
};
export const CompletionExecutionSchema = Type.Union([
  Type.Object(completed, { additionalProperties: false }),
  Type.Object(failed, { additionalProperties: false }),
]);
export const CompletionAttemptSchema = Type.Object({
  attemptId: Type.String(), runId: Type.String(), accountId: Type.String(), provider: Type.String(), model: Type.String(),
  startedAt: Type.Integer({ minimum: 0 }), outcome: Type.Optional(CompletionExecutionSchema),
  recoveryReason: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const CompletionAttemptsSchema = Type.Object({ attempts: Type.Array(CompletionAttemptSchema) }, { additionalProperties: false });
export type CompletionAttempt = Static<typeof CompletionAttemptSchema>;
const identity = {
  requestId: CompletionRequestIdSchema, runId: Type.String(), model: CompletionModelSchema,
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  createdAt: Type.Integer({ minimum: 0 }), updatedAt: Type.Integer({ minimum: 0 }),
  attemptCount: Type.Optional(Type.Integer({ minimum: 0 })), retryAt: Type.Optional(Type.Integer({ minimum: 0 })),
};
export const CompletionRecordSchema = Type.Union([
  Type.Object({ ...identity, state: Type.Union([Type.Literal("queued"), Type.Literal("running")]) }, { additionalProperties: false }),
  Type.Object({ ...identity, ...completed }, { additionalProperties: false }),
  Type.Object({ ...identity, ...failed }, { additionalProperties: false }),
]);
export const CompletionErrorResponseSchema = Type.Object({ error: CompletionErrorSchema }, { additionalProperties: false });
export type CompletionModel = Static<typeof CompletionModelSchema>;
export type CompletionInput = Static<typeof CompletionInputSchema>;
export type CompletionUsage = Static<typeof CompletionUsageSchema>;
export type CompletionResult = Static<typeof CompletionResultSchema>;
export type CompletionError = Static<typeof CompletionErrorSchema>;
export type CompletionExecution = Static<typeof CompletionExecutionSchema>;
export type CompletionRecord = Static<typeof CompletionRecordSchema>;
export type CompletionFetch = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>;
export type CompletionOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CompletionError };

export function completionError(code: CompletionError["code"], message: string): CompletionOutcome<never> {
  return { ok: false, error: { code, message } };
}
export const isCompletionRequestId = (input: unknown): input is string => Check(CompletionRequestIdSchema, input);
export const isCompletionInput = (input: unknown): input is CompletionInput => Check(CompletionInputSchema, input);
export const isCompletionExecution = (input: unknown): input is CompletionExecution => Check(CompletionExecutionSchema, input);
export const isCompletionRecord = (input: unknown): input is CompletionRecord => Check(CompletionRecordSchema, input);
export function completionCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(completionCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${completionCanonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
