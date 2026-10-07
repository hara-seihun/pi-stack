import { Type, type Static } from "typebox";
import { WAIT_KINDS, validateWaitDependency, type Result, type WaitDependency } from "./contracts.js";

const reason = Type.String({ minLength: 1, description: "Required for set: why this named dependency is needed. Finishing work is ordinary idle settlement, not a wait." });
const threadIds = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100, uniqueItems: true });
const after = Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })));
const jobId = Type.String({ minLength: 1 });
const publicationId = Type.String({ minLength: 1 });
const fromThreadId = Type.String({ minLength: 1 });
const choices = Type.Union([
  Type.Object({ action: Type.Literal("set"), kind: Type.Literal("agents"), reason, threadIds, after }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("set"), kind: Type.Literal("job"), reason, jobId }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("set"), kind: Type.Literal("deployment"), reason, publicationId }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("set"), kind: Type.Literal("message"), reason, fromThreadId }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("clear") }, { additionalProperties: false }),
]);

// Anthropic's non-strict projection keeps only root properties/required, not a root union.
// Keep the discriminated alternatives AND an object-shaped field advertisement.
export const threadWaitParameters = Type.Unsafe<Static<typeof choices>>({
  ...Type.Object({
    action: Type.Union([Type.Literal("set"), Type.Literal("clear")]),
    kind: Type.Optional(Type.Union(WAIT_KINDS.map(kind => Type.Literal(kind)), { description: "Required for set. agents needs nonempty accessible peer threadIds; job needs jobId; deployment needs publicationId; message needs accessible collaborator fromThreadId. Omit for clear." })),
    reason: Type.Optional(reason), threadIds: Type.Optional(threadIds), after,
    jobId: Type.Optional(jobId), publicationId: Type.Optional(publicationId), fromThreadId: Type.Optional(fromThreadId),
  }, { additionalProperties: false }),
  anyOf: choices.anyOf,
});

/** Only the old runner's explicit child dependency has an unambiguous typed meaning. */
export function parseRunnerWaitDependency(input: unknown): Result<WaitDependency> {
  if (input && typeof input === "object" && !("kind" in input) && "threadIds" in input && Array.isArray(input.threadIds) && input.threadIds.length) {
    return validateWaitDependency({ ...input, kind: "agents" });
  }
  const parsed = validateWaitDependency(input);
  if (!parsed.ok && input && typeof input === "object" && !("kind" in input)) return {
    ok: false, error: { code: "invalid_request", message: "This runner must name a typed dependency: agents with nonempty accessible peer threadIds, job with jobId, deployment with publicationId, or message with fromThreadId. If work is finished, end the turn normally; no waiting status was recorded. Retained runner tools refresh after accepted work settles, not during active work." },
  };
  return parsed;
}
