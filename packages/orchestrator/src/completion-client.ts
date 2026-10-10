import { readFileSync } from "node:fs";
import { modelBrokerUrl } from "./model-broker-contract.js";
import { completionError, isCompletionRecord, isCompletionRequestId, type CompletionError, type CompletionInput, type CompletionFetch, type CompletionOutcome, type CompletionRecord } from "./completion-contract.js";

/** Codes a broker answers with when it refuses a request; anything else is a protocol fault. */
const REJECTION_CODES = ["invalid-request", "unsupported-option", "not-found", "request-conflict", "invalid-state", "model-disabled", "model-policy-unavailable"] as const satisfies readonly CompletionError["code"][];

export interface CompletionClientOptions {
  readonly baseUrl?: string;
  readonly tokenFile?: string;
  readonly fetch?: CompletionFetch;
  readonly timeoutMs?: number;
}
export interface CompletionCallOptions { readonly signal?: AbortSignal }

export class CompletionClient {
  private readonly baseUrl: string | undefined;
  private readonly tokenFile: string | undefined;
  private readonly requiresToken: boolean;
  private readonly fetch: CompletionFetch;
  private readonly timeoutMs: number;
  constructor(options: CompletionClientOptions = {}) {
    const coreUrl = process.env.PI_CORE_URL;
    this.baseUrl = (options.baseUrl ?? (coreUrl ? `${coreUrl.replace(/\/$/, "")}/v1/model-broker` : modelBrokerUrl()))?.replace(/\/$/, "");
    this.tokenFile = options.tokenFile ?? process.env.PI_CORE_TOKEN_FILE;
    this.requiresToken = options.baseUrl === undefined && coreUrl !== undefined;
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
    if (!this.baseUrl) return completionError("invalid-request", "Set PI_CORE_URL and PI_CORE_TOKEN_FILE, or an explicit principal-bound model broker URL.");
    if (this.requiresToken && !this.tokenFile) return completionError("authentication", "PI_CORE_TOKEN_FILE is required for core inference.");
    let response: Response;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.tokenFile) {
        const token = readFileSync(this.tokenFile, "utf8").trim();
        if (!token || /\s/.test(token)) return completionError("authentication", "Core token file is empty or invalid.");
        headers.authorization = `Bearer ${token}`;
      }
      response = await this.fetch(`${this.baseUrl}/v1/completions/${encodeURIComponent(requestId)}${suffix}`, {
        method,
        headers,
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
          const code = REJECTION_CODES.find(known => known === error.code) ?? "protocol";
          return completionError(code, error.message);
        }
      }
      return completionError("protocol", `Unexpected completion response, HTTP ${response.status}.`);
    } catch (cause) {
      return completionError("protocol", `Unreadable completion response: ${cause instanceof Error ? cause.message : String(cause)}. Reuse request ID ${requestId} to recover.`);
    }
  }
}
