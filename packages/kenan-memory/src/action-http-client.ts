import { validActionResponse } from "./action-response.js";
import type { ActionEvidence, ActionInput, ActionRecord, ActionResult, ActionSubmission, ActionTicket } from "./actions.js";

/** Native sessions can run inside the supervisor; their authority calls must not block its event loop. */
export class ActionHttpClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  constructor(env: NodeJS.ProcessEnv) {
    const origin = new URL(env.PI_REMOTE_SERVER_URL ?? `http://127.0.0.1:${env.PI_REMOTE_ROUTER_PORT ?? "8788"}`);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Action authority must be own loopback supervisor/router");
    this.url = `${origin.origin}/v1/external-actions`;
    this.headers = { "content-type": "application/json", ...(env.PI_REMOTE_SERVER_URL && env.PI_THREAD_TOKEN ? { "x-pi-thread-token": env.PI_THREAD_TOKEN } : {}) };
  }
  private async request<T>(operation: string, input: unknown): Promise<ActionResult<T>> {
    try {
      const response = await fetch(this.url, { method: "POST", headers: this.headers, body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!validActionResponse(operation, result)) throw new Error("Invalid authority response");
      return result as ActionResult<T>;
    } catch { return { ok: false, error: "unavailable", message: "Canonical action authority response unavailable; inspect existing intent, never dispatch without its current fence" }; }
  }
  close(): void {}
  submit(input: ActionInput): Promise<ActionResult<ActionSubmission>> { return this.request("submit", input); }
  claim(id: string, actor: string): Promise<ActionResult<ActionTicket>> { return this.request("claim", { id, actor }); }
  dispatch(ticket: ActionTicket): Promise<ActionResult<null>> { return this.request("dispatch", { ticket }); }
  finish(ticket: ActionTicket, outcome: "succeeded" | "failed-before-effect" | "uncertain", result: unknown, evidence: ActionEvidence): Promise<ActionResult<ActionRecord>> { return this.request("finish", { ticket, outcome, result, evidence }); }
  followup(priorId: string, expectedRevision: number, input: ActionInput, evidence: ActionEvidence): Promise<ActionResult<ActionSubmission>> { return this.request("followup", { priorId, expectedRevision, input, evidence }); }
  inspect(id: string): Promise<ActionResult<ActionRecord>> { return this.request("inspect", { id }); }
  list(): Promise<ActionResult<ActionRecord[]>> { return this.request("list", {}); }
  reconcile(id: string, expectedRevision: number, decision: "effect-confirmed" | "no-effect-confirmed" | "resolve-purpose" | "hold", evidence: ActionEvidence, actor: string): Promise<ActionResult<ActionRecord>> { return this.request("reconcile", { id, expectedRevision, decision, evidence, actor }); }
  retryNoEffect(id: string, expectedRevision: number, evidence: ActionEvidence, actor: string): Promise<ActionResult<ActionRecord>> { return this.request("retry", { id, expectedRevision, evidence, actor }); }
}
