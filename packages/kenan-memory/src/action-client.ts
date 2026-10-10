import { spawnSync } from "node:child_process";
import { validActionResponse } from "./action-response.js";
import type { ActionEvidence, ActionInput, ActionRecord, ActionResult, ActionSubmission, ActionTicket } from "./actions.js";

/** All writers cross the canonical supervisor; separate encrypted mounts never become competing SQLite owners. */
export class ActionClient {
  private readonly origin: string;
  constructor(origin: string, private readonly phoneToken?: string, private readonly threadToken?: string) {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("Action authority must be the canonical owner's loopback supervisor/router");
    this.origin = url.origin;
  }
  private request<T>(operation: string, input: unknown): ActionResult<T> {
    const headers = ["content-type: application/json", ...(this.phoneToken ? [`authorization: Bearer ${this.phoneToken}`] : []), ...(this.threadToken ? [`x-pi-thread-token: ${this.threadToken}`] : [])];
    // Credentials and payload travel on stdin, never process arguments or a temporary plaintext file.
    const config = [`url = ${JSON.stringify(`${this.origin}/v1/external-actions`)}`, 'request = "POST"', ...headers.map(h => `header = ${JSON.stringify(h)}`), `data = ${JSON.stringify(JSON.stringify({ operation, input }))}`].join("\n") + "\n";
    const response = spawnSync("curl", ["--silent", "--show-error", "--max-time", "5", "--config", "-"], { input: config, encoding: "utf8", timeout: 6000, maxBuffer: 4 * 1024 * 1024 });
    if (response.status !== 0) return { ok: false, error: "unavailable", message: "Canonical action authority response unavailable. Mutation may have committed; inspect existing intent, never dispatch without its current fence." };
    try {
      const result = JSON.parse(response.stdout);
      if (!validActionResponse(operation, result)) throw new Error("Invalid authority response");
      return result as ActionResult<T>;
    } catch { return { ok: false, error: "unavailable", message: "Canonical action authority returned no valid receipt; no dispatch permitted" }; }
  }
  close(): void {}
  submit(input: ActionInput): ActionResult<ActionSubmission> { return this.request("submit", input); }
  inspect(id: string): ActionResult<ActionRecord> { return this.request("inspect", { id }); }
  list(): ActionResult<ActionRecord[]> { return this.request("list", {}); }
  claim(id: string, actor: string): ActionResult<ActionTicket> { return this.request("claim", { id, actor }); }
  dispatch(ticket: ActionTicket): ActionResult<null> { return this.request("dispatch", { ticket }); }
  finish(ticket: ActionTicket, outcome: "succeeded" | "failed-before-effect" | "uncertain", result: unknown, evidence: ActionEvidence): ActionResult<ActionRecord> { return this.request("finish", { ticket, outcome, result, evidence }); }
  abandon(ticket: ActionTicket, evidence: ActionEvidence): ActionResult<ActionRecord> { return this.finish(ticket, "uncertain", null, evidence); }
  reconcile(id: string, expectedRevision: number, decision: "effect-confirmed" | "no-effect-confirmed" | "resolve-purpose" | "hold", evidence: ActionEvidence, actor: string): ActionResult<ActionRecord> { return this.request("reconcile", { id, expectedRevision, decision, evidence, actor }); }
  recover(id: string, expectedRevision: number, evidence: ActionEvidence, actor: string): ActionResult<ActionRecord> { return this.request("recover", { id, expectedRevision, evidence, actor }); }
  retryNoEffect(id: string, expectedRevision: number, evidence: ActionEvidence, actor: string): ActionResult<ActionRecord> { return this.request("retry", { id, expectedRevision, evidence, actor }); }
  followup(priorId: string, expectedRevision: number, input: ActionInput, evidence: ActionEvidence): ActionResult<ActionSubmission> { return this.request("followup", { priorId, expectedRevision, input, evidence }); }
  holdRecipient(recipient: string, reason: string, actor: string): ActionResult<null> { return this.request("hold-recipient", { recipient, reason, actor }); }
  releaseRecipient(recipient: string, evidence: ActionEvidence, actor: string): ActionResult<null> { return this.request("release-recipient", { recipient, evidence, actor }); }
  linkRecipients(identities: string[], actor: string): ActionResult<null> { return this.request("link-recipients", { identities, actor }); }
}
