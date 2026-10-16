import type { DatabaseSync } from "node:sqlite";
import type { PermissionAction, Resource } from "../permissions.js";
import type { ManagerQuestionCustodyRequest, ManagerQuestionCustodyReceipt, Result } from "../threads/contracts.js";
import type { ThreadOwner } from "../threads/directory.js";
import { createThreadClient } from "../threads/http.js";
type ThreadFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
import type { ManagerReplies, ManagerRepliesInput } from "./manager-replies.js";

export type CoreManagerRelayConfig = {
  scopeId: string;
  environmentId: string;
  callbackUrl: string;
  canonicalManager: { environmentId: string; threadId: string } | null;
  remoteEnvironments: { id: string; resource: Resource }[];
  adoptedOrigins: { threadId: string; environmentId: string }[];
};
const operations = new Set(["managerNotificationPolicy", "managerWorkSummary", "send", "questionOrigin", "managerQuestionCustody"]);
const failure = (code: "unavailable" | "conflict" | "invalid_request", message: string): Result<never> => ({ ok: false, error: { code, message } });

/** Scope-bound provenance and transport only. Native ThreadService owns questions and receipts. */
export class CoreManagerRelay {
  private readonly peers = new Map<string, ThreadOwner>();
  constructor(readonly config: CoreManagerRelayConfig, private readonly db: DatabaseSync, private readonly transport: ThreadFetch,
    private readonly authorize: (resource: Resource, action: PermissionAction) => Result<void>) {
    if (!config.scopeId || !/^[a-z][a-z0-9-]{0,31}$/.test(config.environmentId)) throw new Error("Manager relay requires explicit scope/environment identity");
    if (new Set(config.remoteEnvironments.map(row => row.id)).size !== config.remoteEnvironments.length
      || config.remoteEnvironments.some(row => !/^[a-z][a-z0-9-]{0,31}$/.test(row.id) || row.id === config.environmentId)) throw new Error("Manager relay remote environments must be unique and nonlocal");
    const callback = new URL(config.callbackUrl);
    if (!["http:", "https:"].includes(callback.protocol) || callback.username || callback.password || callback.search || callback.hash) throw new Error("Manager relay callback URL is invalid");
    if (config.canonicalManager && (!config.canonicalManager.threadId || config.canonicalManager.environmentId !== config.environmentId && !config.remoteEnvironments.some(row => row.id === config.canonicalManager!.environmentId))) throw new Error("Canonical manager has no declared environment");
    db.exec("CREATE TABLE IF NOT EXISTS core_manager_origin(scope_id TEXT NOT NULL,thread_id TEXT NOT NULL,environment_id TEXT NOT NULL,PRIMARY KEY(scope_id,thread_id))");
    for (const origin of config.adoptedOrigins) {
      const result = this.recordOrigin(origin.threadId, origin.environmentId);
      if (!result.ok) throw new Error(result.error.message);
    }
    for (const environment of config.remoteEnvironments) {
      const api = createThreadClient(config.callbackUrl, async (input, init) => {
        const operation = new URL(String(input)).pathname.split("/").at(-1)!;
        if (!operations.has(operation)) return Response.json(failure("invalid_request", `Manager relay does not transport ${operation}`), { status: 400 });
        const granted = this.authorize(environment.resource, ["managerNotificationPolicy", "managerWorkSummary", "questionOrigin"].includes(operation) ? "read" : "write");
        if (!granted.ok) return Response.json(granted, { status: 403 });
        return transport(input, { ...init, body: JSON.stringify({ input: JSON.parse(String(init?.body)), environmentId: environment.id }) });
      });
      this.peers.set(environment.id, { id: `manager-origin:${environment.id}`, api });
    }
  }
  get managerOwner(): ThreadOwner | undefined {
    const target = this.config.canonicalManager;
    return target && target.environmentId !== this.config.environmentId ? this.peers.get(target.environmentId) : undefined;
  }
  async managerReplies(input: ManagerRepliesInput): Promise<Result<ManagerReplies>> {
    const target = this.config.canonicalManager;
    if (!target || target.environmentId === this.config.environmentId) return failure("unavailable", "Remote canonical manager is unset");
    const environment = this.config.remoteEnvironments.find(row => row.id === target.environmentId);
    if (!environment) return failure("unavailable", "Canonical manager environment is undeclared");
    const granted = this.authorize(environment.resource, "read");
    if (!granted.ok) return granted;
    try {
      const response = await this.transport(`${this.config.callbackUrl.replace(/\/$/, "")}/managerReplies`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, environmentId: environment.id }), signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as Result<ManagerReplies>;
      if (!response.ok || typeof result?.ok !== "boolean") return failure("unavailable", `Manager reply transport returned HTTP ${response.status}`);
      if (result.ok && result.value.managerThreadId !== target.threadId) return failure("conflict", "Reply transport names another manager");
      return result;
    } catch (cause) { return failure("unavailable", `Manager replies unavailable: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  questionOwner = (threadId: string): ThreadOwner | null => {
    const origin = this.db.prepare("SELECT environment_id FROM core_manager_origin WHERE scope_id=? AND thread_id=?").get(this.config.scopeId, threadId) as { environment_id: string } | undefined;
    return origin ? this.peers.get(origin.environment_id) ?? null : null;
  };
  private recordOrigin(threadId: string, environmentId: string): Result<void> {
    if (!threadId || !this.config.remoteEnvironments.some(row => row.id === environmentId)) return failure("invalid_request", "Question origin requires a declared remote environment and thread");
    const previous = this.db.prepare("SELECT environment_id FROM core_manager_origin WHERE scope_id=? AND thread_id=?").get(this.config.scopeId, threadId) as { environment_id: string } | undefined;
    if (previous && previous.environment_id !== environmentId) return failure("conflict", "Question origin ownership conflicts");
    this.db.prepare("INSERT OR IGNORE INTO core_manager_origin VALUES(?,?,?)").run(this.config.scopeId, threadId, environmentId);
    return { ok: true, value: undefined };
  }
  async receive(request: Request, input: ManagerQuestionCustodyRequest, trustedRemoteService: boolean,
    dispatch: (input: ManagerQuestionCustodyRequest) => Promise<Result<ManagerQuestionCustodyReceipt>>): Promise<Result<ManagerQuestionCustodyReceipt>> {
    if (input?.action === "receive" && request.headers.has("x-pi-remote-manager-origin")) {
      if (!trustedRemoteService || request.headers.get("x-pi-core-router-confirmed") !== "true") return failure("unavailable", "Question provenance requires authenticated Remote router ingress");
      const source = request.headers.get("x-pi-remote-manager-origin")!;
      const target = this.config.canonicalManager;
      if (!target || target.environmentId !== this.config.environmentId || target.threadId !== input.threadId) return failure("conflict", "Question custody does not name this canonical manager");
      if (source !== this.config.environmentId) {
        const environment = this.config.remoteEnvironments.find(row => row.id === source);
        if (!environment) return failure("invalid_request", "Question source environment is undeclared");
        const granted = this.authorize(environment.resource, "read");
        if (!granted.ok) return granted;
        const recorded = this.recordOrigin(input.originThreadId, source);
        if (!recorded.ok) return recorded;
      }
    }
    return dispatch(input);
  }
}
