import type { Database } from "bun:sqlite";
import { validateManagerWorkSummary, type ThreadApi, type ManagerNotificationPolicy } from "pi-orchestrator/api";

export async function managerRelay(req: Request, owner: {
  db: Database; environmentId: string; authorizedRouter: boolean;
  threads: Pick<ThreadApi, "managerNotificationPolicy" | "send">;
  directory: Pick<ThreadApi, "questionOrigin" | "managerQuestionCustody" | "managerWorkSummary">;
  manager: ManagerNotificationPolicy | null;
}): Promise<Response> {
  const failure = (message: string, status: number) => Response.json({ ok: false, error: { code: "unavailable", message } }, { status });
  if (!owner.authorizedRouter) return failure("Manager relay requires this account's authorized router", 403);
  const operation = new URL(req.url).pathname.slice("/v1/manager-relay/".length);
  if (req.method !== "POST") return failure("Use POST", 405);
  if (operation === "managerNotificationPolicy") return owner.manager ? Response.json(await owner.threads.managerNotificationPolicy()) : failure("This is not the canonical manager owner", 409);
  const input = await req.json().catch(() => null);
  if (operation === "managerWorkSummary") {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) return failure("Work summary requires an empty object", 400);
    const result = await owner.directory.managerWorkSummary();
    if (!result.ok) return Response.json(result);
    return validateManagerWorkSummary(result.value) ? Response.json({ ok: true, value: result.value })
      : failure("Thread directory returned an invalid work summary", 503);
  }
  if (operation === "questionOrigin") {
    if (!input || typeof input.threadId !== "string" || Object.keys(input).some(key => key !== "threadId")) return failure("Question origin requires one thread identity", 400);
    return Response.json(await owner.directory.questionOrigin(input.threadId));
  }
  if (operation === "managerQuestionCustody") {
    if (!input || typeof input.threadId !== "string") return failure("Question custody requires a destination", 400);
    if (input.action === "receive") {
      const sourceEnvironment = req.headers.get("x-pi-remote-manager-origin");
      if (!owner.manager || !sourceEnvironment || !/^[a-z][a-z0-9-]{0,31}$/.test(sourceEnvironment) || typeof input.originThreadId !== "string") return failure("Question custody requires its router-bound origin", 400);
      if (sourceEnvironment !== owner.environmentId) {
        const key = `manager-origin:${input.originThreadId}`;
        const prior = owner.db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null;
        if (prior && prior.value !== sourceEnvironment) return failure("Question origin ownership conflicts", 409);
        owner.db.query("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)").run(key, sourceEnvironment);
      }
    }
    return Response.json(await owner.directory.managerQuestionCustody(input));
  }
  if (operation !== "send" || !owner.manager) return failure("Manager relay operation is unavailable", 400);
  const policy = owner.manager;
  if (!input || policy.view !== "mono" || input.threadId !== policy.managerThreadId || input.source !== "notification"
    || input.delivery !== "steer" || typeof input.senderId !== "string" || !input.senderId.trim()
    || typeof input.text !== "string" || !input.text.trim() || typeof input.requestId !== "string" || !input.requestId.startsWith("manager-notice:")
    || Object.keys(input).some(key => !["threadId", "senderId", "source", "delivery", "text", "requestId"].includes(key)))
    return failure("Relay requires one stable manager notice for the current mono manager", 400);
  return Response.json(await owner.threads.send(input));
}
