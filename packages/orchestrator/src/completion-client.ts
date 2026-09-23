import { orchestratorUrl } from "./config.js";
import { modelBrokerUrl } from "./model-broker-contract.js";
import { completionError, isCompletionRecord, isCompletionRequestId, type CompletionInput, type CompletionFetch, type CompletionOutcome, type CompletionRecord } from "./completion-contract.js";

export interface CompletionClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: CompletionFetch;
  readonly timeoutMs?: number;
}
export interface CompletionCallOptions { readonly signal?: AbortSignal }

export class CompletionClient {
  private readonly baseUrl: string;
  private readonly fetch: CompletionFetch;
  private readonly timeoutMs: number;
  constructor(options: CompletionClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? modelBrokerUrl() ?? orchestratorUrl()).replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }
  submit(requestId: string, input: CompletionInput, options: CompletionCallOptions = {}): Promise<CompletionOutcome<CompletionRecord>> {
    return this.call(requestId, "PUT", "", input, options);
  }
  get(requestId: string, options: CompletionCallOptions = {}): Promise<CompletionOutcome<CompletionRecord>> {
    return this.call(requestId, "GET", "", undefined, options);
  }
  retryRejected(requestId: string, options: CompletionCallOptions = {}): Promise<CompletionOutcome<CompletionRecord>> {
    return this.call(requestId, "POST", "/retry", undefined, options);
  }
  cancel(requestId: string, options: CompletionCallOptions = {}): Promise<CompletionOutcome<CompletionRecord>> {
    return this.call(requestId, "POST", "/cancel", undefined, options);
  }
  private async call(requestId: string, method: string, suffix: string, input: CompletionInput | undefined, options: CompletionCallOptions): Promise<CompletionOutcome<CompletionRecord>> {
    if (!isCompletionRequestId(requestId)) return completionError("invalid-request", "Invalid completion request ID; openapi.json is reserved.");
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/completions/${encodeURIComponent(requestId)}${suffix}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])]),
      });
    } catch (cause) {
      return completionError("transport", `Completion request ${requestId}: ${cause instanceof Error ? cause.message : String(cause)}. Reuse this request ID to recover; transport cancellation does not cancel durable work.`);
    }
    try {
      const value: unknown = await response.json();
      if (response.ok && isCompletionRecord(value) && value.requestId === requestId) return { ok: true, value };
      if (!response.ok && value && typeof value === "object" && "error" in value) {
        const error = value.error;
        if (error && typeof error === "object" && "code" in error && "message" in error && typeof error.code === "string" && typeof error.message === "string") {
          const code = ["invalid-request", "unsupported-option", "not-found", "request-conflict", "invalid-state"].includes(error.code) ? error.code as "invalid-request" | "unsupported-option" | "not-found" | "request-conflict" | "invalid-state" : "protocol";
          return completionError(code, error.message);
        }
      }
      return completionError("protocol", `Unexpected completion response, HTTP ${response.status}.`);
    } catch (cause) {
      return completionError("protocol", `Unreadable completion response: ${cause instanceof Error ? cause.message : String(cause)}. Reuse request ID ${requestId} to recover.`);
    }
  }
}
