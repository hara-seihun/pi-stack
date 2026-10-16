import { COMPLETION_OPENAPI } from "./completion-openapi.js";
import { completionHttpStatus, isCompletionRequestId, type CompletionOutcome, type CompletionRecord } from "./completion-contract.js";
import type { ProviderController } from "./provider-controller.js";
export type DirectCompletionOperation = "read" | "submit" | "retry" | "cancel";
export function directCompletionOperation(method: string, path: string): DirectCompletionOperation | undefined {
  if (method === "GET" && path === "/v1/completions/openapi.json") return "read";
  const route = /^\/v1\/completions\/([^/]+)(\/(?:attempts|retry|cancel))?$/.exec(path);
  if (!route) return;
  if (method === "GET" && (!route[2] || route[2] === "/attempts")) return "read";
  if (method === "PUT" && !route[2]) return "submit";
  if (method === "POST" && route[2] === "/retry") return "retry";
  if (method === "POST" && route[2] === "/cancel") return "cancel";
}
/** Core applies the original caller ceiling and operation-specific resource first. */
export async function completionHttp(controller: ProviderController, request: Request): Promise<Response | undefined> {
  const url = new URL(request.url), method = request.method;
  const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
  const reply = (outcome: CompletionOutcome<CompletionRecord>) => outcome.ok ? Response.json(outcome.value) : fail(completionHttpStatus(outcome.error.code), outcome.error.code, outcome.error.message);
  if (!url.pathname.startsWith("/v1/completions/")) return;
  if (method === "GET" && url.pathname === "/v1/completions/openapi.json") return Response.json(COMPLETION_OPENAPI);
  try {
    const route = /^\/v1\/completions\/([^/]+)(\/(?:attempts|retry|cancel))?$/.exec(url.pathname);
    if (!route) return fail(404, "not-found", "Completion operation not found");
    const id = decodeURIComponent(route[1]!);
    if (!isCompletionRequestId(id)) return fail(400, "invalid-request", "Invalid original completion ID");
    const operation = directCompletionOperation(method, url.pathname);
    if (operation === "read") {
      if (route[2]) { const attempts = controller.completions.attempts(id); return attempts ? Response.json({ attempts }) : fail(404, "not-found", "Completion not found"); }
      const record = controller.completions.get(id); return record ? Response.json(record) : fail(404, "not-found", "Completion not found");
    }
    if (operation === "submit") return reply(controller.completions.submitOwner(id, await request.json()));
    if (operation === "retry") return reply(controller.completions.retry(id));
    if (operation === "cancel") { const result = controller.completions.cancel(id); controller.tick(); return reply(result); }
    return fail(405, "invalid-request", "Unsupported original completion operation");
  } catch (cause) {
    if (cause instanceof SyntaxError || cause instanceof URIError) return fail(400, "invalid-request", "Invalid original completion encoding");
    return fail(503, "invalid-state", "Original completion custody is unavailable; no provider request was replayed");
  }
}
