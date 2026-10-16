import { CompletionErrorResponseSchema, CompletionInputSchema, CompletionRecordSchema, CompletionResultSchema, CompletionUsageSchema, CompletionAttemptsSchema } from "./completion-contract.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string) => ({ "application/json": { schema: ref(name) } });
const record = { description: "Durable completion status. Replaying the same request ID never creates another logical request. Only explicit pre-execution rate-limit rejections may receive another durable attempt; unknown outcomes remain fenced.", content: content("CompletionRecord") };
const errors = Object.fromEntries([
  ["400", "Invalid request"], ["404", "Request not found"], ["409", "Request ID conflict or invalid state"],
  ["422", "Unsupported native provider option"], ["500", "Orchestrator failure"],
].map(([status, description]) => [status!, { description, content: content("CompletionErrorResponse") }]));
const parameters = [{ name: "requestId", in: "path", required: true, schema: CompletionRecordSchema.anyOf[0]!.properties.requestId }];

export const COMPLETION_OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Pi Stack durable completions", version: "1.0.0" },
  paths: {
    "/v1/completions/{requestId}": {
      parameters,
      put: {
        operationId: "submitCompletion",
        description: "Atomically stores caller input and one tool-free Orchestrator run. Same ID and identical input replay the existing record; changed input conflicts. Network disconnect does not cancel work. Luna accepts native strict JSON schema; maxOutputTokens is rejected before admission on the Codex route.",
        requestBody: { required: true, content: content("CompletionInput") },
        responses: { "200": record, "202": record, ...errors },
      },
      get: { operationId: "getCompletion", responses: { "200": record, ...errors } },
    },
    "/v1/completions/{requestId}/retry": {
      parameters,
      post: { operationId: "retryRejectedCompletion", description: "Requeues only an explicit pre-execution rate-limit rejection, preserving request/run IDs and immutable attempt receipts. Idempotent for queued, running and completed requests. Indeterminate and cancelled outcomes cannot be retried.", responses: { "200": record, ...errors } },
    },
    "/v1/completions/{requestId}/attempts": {
      parameters,
      get: { operationId: "completionAttempts", responses: { "200": { description: "Append-only provider attempt custody and rejection recovery provenance.", content: content("CompletionAttempts") }, ...errors } },
    },
    "/v1/completions/{requestId}/cancel": {
      parameters,
      post: { operationId: "cancelCompletion", description: "Cancels durable work. Terminal results remain unchanged. An in-flight provider call may already have spent tokens.", responses: { "200": record, ...errors } },
    },
  },
  components: { schemas: { CompletionAttempts: CompletionAttemptsSchema, CompletionInput: CompletionInputSchema, CompletionRecord: CompletionRecordSchema, CompletionResult: CompletionResultSchema, CompletionUsage: CompletionUsageSchema, CompletionErrorResponse: CompletionErrorResponseSchema } },
} as const;
