import { afterEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ThreadService, ThreadDirectory, type ThreadApi, type ManagerNotificationPolicy, type Result } from "pi-orchestrator/api";
import { ensureSupervisorSchema, recordIdleNotification } from "./database";
import { idleNotifications, notificationHistory } from "./notifications";
import { notificationUnread, humanQuestions } from "./notification-policy";
import { projectThreadNotifications } from "./thread-notifications";
import { handleAgentManager } from "./agent-manager";
import { managerRelay } from "./manager-relay";
import { managerRelayClient } from "./manager-relay-client";
import type { Person } from "./persons";

const mono: ManagerNotificationPolicy = { view: "mono", managerThreadId: "manager" };
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw Error(result.error.message); return result.value; };
const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
function database() { const db = new Database(":memory:"); ensureSupervisorSchema(db); disposals.push(() => db.close()); return db; }

function service(policy: () => ManagerNotificationPolicy) {
  const root = mkdtempSync(join(tmpdir(), "manager-notification-"));
  const value = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), capacity: { mode: "unmanaged" },
    managerNotificationPolicy: () => ({ ok: true, value: policy() }),
    openSession: async () => { throw Error("No native session in routing test"); } });
  disposals.push(async () => { await value.close(); rmSync(root, { recursive: true, force: true }); });
  return { value, root };
}

test("mono filters saved classic notices, history and badges without destroying read receipts", () => {
  const db = database();
  for (const id of ["manager", "child", "watch"]) for (const kind of ["idle", "question", "attention"] as const)
    recordIdleNotification(db, `${id}:${kind}`, { id, title: id }, 1, { kind, body: kind });
  const accessible = () => ({ parentId: null, foreground: true });
  expect(idleNotifications(db, 0, accessible, mono).notifications.map(item => [item.sessionId, item.kind])).toEqual([["manager", "attention"]]);
  expect(idleNotifications(db, 0, accessible, mono).cursor).toBe(9);
  expect(notificationHistory(db, null, accessible, 100, mono).notifications.map(item => [item.sessionId, item.kind])).toEqual([["manager", "attention"]]);
  expect(notificationUnread(db, mono, "child", true)).toBe(false);
  expect(notificationUnread(db, mono, "manager", true)).toBe(true);
  expect(idleNotifications(db, 0, accessible, null).notifications).toEqual([]);
  expect(idleNotifications(db, 0, accessible, { view: "classic" }).notifications).toHaveLength(9);
  expect(db.query("SELECT sum(idle_unread) n FROM thread_views").get()).toEqual({ n: 3 });
});

test("mono question panels require the manager's exact authored question identity", () => {
  const db = database();
  const questions = [{ id: "manager:q-one", threadId: "manager" }, { id: "manager:q-two", threadId: "manager" }, { id: "child:q", threadId: "child" }];
  expect(humanQuestions(db, mono, questions)).toEqual([]);
  recordIdleNotification(db, "unrelated", { id: "manager", title: "Manager" }, 1, { kind: "attention", body: "Leave at six" });
  expect(humanQuestions(db, mono, questions)).toEqual([]);
  recordIdleNotification(db, "child", { id: "child", title: "Child" }, 2, { kind: "attention", body: "manager:q-one" });
  expect(humanQuestions(db, mono, questions)).toEqual([]);
  recordIdleNotification(db, "chosen", { id: "manager", title: "Manager" }, 3, { kind: "attention", body: "Choose a route: #/chats/ai:manager?question=manager:q-one" });
  expect(humanQuestions(db, mono, questions)).toEqual([questions[0]!]);
  expect(humanQuestions(db, { view: "classic" }, questions)).toEqual(questions);
});

test("invalid remote policy never grants notification delivery", async () => {
  for (const value of [null, {}, { view: "mono" }, { view: "mono", managerThreadId: " " }, { view: "other" }, { view: "classic", thread: { cwd: "/private" } }]) {
    const client = managerRelayClient("http://router/v1/agent-manager", undefined, async () => Response.json({ ok: true, value }));
    expect((await client.managerNotificationPolicy()).ok).toBe(false);
  }
});

test("child attention and settlements route durably to manager, never native feed, including replay", async () => {
  const db = database(), f = service(() => mono);
  unwrap(await f.value.spawn({ id: "manager", requestId: "spawn-manager", cwd: f.root, metadata: { manager: true } }));
  unwrap(await f.value.spawn({ id: "child", requestId: "spawn-child", cwd: f.root }));
  unwrap(await f.value.attention({ requestId: "child-attention", threadId: "child", summary: "Changed plan" }));
  unwrap(await f.value.attention({ requestId: "manager-attention", threadId: "manager", summary: "Leave at six" }));
  const api = Object.create(f.value) as ThreadApi;
  api.settlements = after => ({ ok: true, value: { cursor: 1, items: after ? [] : [{ seq: 1, executionId: "execution-child", workId: "work-child", threadId: "child", outcome: "complete", time: 1, finalMessage: { role: "assistant", content: [{ type: "text", text: "Done" }] } }] } });
  const directory = new ThreadDirectory({ id: "person", api: f.value });
  await projectThreadNotifications(db, "person", api, directory, undefined, mono);
  await projectThreadNotifications(db, "person", api, directory, undefined, mono);
  expect(idleNotifications(db, 0, () => ({ parentId: null }), mono).notifications.map(item => item.body)).toEqual(["Leave at six"]);
  const notices = f.value.pending("manager").filter(item => item.id.startsWith("manager-notice:"));
  expect(notices).toHaveLength(2);
  expect(notices.every(item => item.source === "notification" && item.senderId === "child")).toBe(true);
});

test("mono custody never expires into human questions and classic release remains available", async () => {
  let policy: ManagerNotificationPolicy = mono;
  const f = service(() => policy);
  unwrap(await f.value.spawn({ id: "manager", requestId: "manager", cwd: f.root, metadata: { manager: true } }));
  unwrap(await f.value.spawn({ id: "child", requestId: "child", cwd: f.root }));
  const id = unwrap(await f.value.ask({ threadId: "child", requestId: "question", questions: [{ question: "Which route?" }] })).questionIds[0]!;
  const created = unwrap(await f.value.questionState("child", id)).question.createdAt;
  const clock = spyOn(Date, "now").mockReturnValue(created + 3 * 60 * 60_000);
  try {
    expect(unwrap(f.value.questionEvents()).items).toEqual([]);
    expect(unwrap(await f.value.questions("child"))).toEqual([]);
    expect(unwrap(await f.value.managerQuestions({ action: "list", threadId: "manager" }))).toMatchObject({ questions: [{ id, routing: "held" }] });
    policy = { view: "classic" };
    unwrap(await f.value.managerNotificationPolicy());
    expect(unwrap(f.value.questionEvents()).items).toMatchObject([{ questionId: id }]);
  } finally { clock.mockRestore(); }
});

test("account bridge binds kernel UID and only routes allowed manager operations", async () => {
  const person: Person = { version: 1, user: "person", displayName: "Person", port: 10000, environment: { PI_REMOTE_MANAGER_ENVIRONMENT: "home" } };
  let forwarded: { owner: string; origin: string; source: string; path: string; body: unknown } | null = null;
  const handle = (uid: number, operation: string, environmentId?: string) => handleAgentManager(new Request(`http://router/v1/agent-manager/${operation}`, {
    method: "POST", body: JSON.stringify({ input: {}, ...(environmentId ? { environmentId } : {}) }) }), { uid }, new Map([[1000, "person"]]), () => person,
    () => [{ id: "work", name: "Work", baseUrl: "" }, { id: "home", name: "Home", baseUrl: "/v1/remotes/home", upstreams: { person: "http://home:10000" } }], "work",
    async (owner, origin, req, target, _upstream, source) => { forwarded = { owner: owner.user, origin, source, path: target.pathname, body: await req.json() }; return Response.json({ ok: true }); });
  expect((await handle(2000, "managerNotificationPolicy")).status).toBe(403);
  expect((await handle(1000, "read")).status).toBe(400);
  expect((await handle(1000, "managerNotificationPolicy", "other")).status).toBe(503);
  expect((await handle(1000, "managerNotificationPolicy")).status).toBe(200);
  expect(forwarded as unknown).toEqual({ owner: "person", origin: "http://home:10000", source: "work", path: "/v1/manager-relay/managerNotificationPolicy", body: {} });
});

test("cross-host questions retain custody through manager forward and correlated answer", async () => {
  const homeDb = database(), workDb = database();
  const home = service(() => mono), work = service(() => mono);
  unwrap(await home.value.spawn({ id: "manager", requestId: "manager", cwd: home.root, metadata: { manager: true } }));
  unwrap(await work.value.spawn({ id: "child", requestId: "child", cwd: work.root }));
  let homeDirectory: ThreadDirectory, workDirectory: ThreadDirectory;
  const client = (source: "home" | "work", target: "home" | "work") => managerRelayClient("http://router/v1/agent-manager", target, async (url, init) => {
    const request = new Request(url, init), envelope = await request.json() as { input: unknown; environmentId: string };
    const destination = envelope.environmentId;
    const relayed = new Request(String(url).replace("agent-manager", "manager-relay"), { method: "POST", headers: { "x-pi-remote-manager-origin": source }, body: JSON.stringify(envelope.input) });
    return managerRelay(relayed, destination === "home"
      ? { db: homeDb, environmentId: "home", authorizedRouter: true, threads: home.value, directory: homeDirectory, manager: mono }
      : { db: workDb, environmentId: "work", authorizedRouter: true, threads: work.value, directory: workDirectory, manager: null });
  });
  const canonical = client("work", "home");
  workDirectory = new ThreadDirectory({ id: "person", api: work.value }, [], { id: "manager", api: canonical });
  homeDirectory = new ThreadDirectory({ id: "person", api: home.value }, [], undefined, id => {
    const route = homeDb.query("SELECT value FROM metadata WHERE key=?").get(`manager-origin:${id}`) as { value: string } | null;
    return route?.value === "work" ? { id: "origin-work", api: client("home", "work") } : null;
  });
  work.value.setDirectory(workDirectory); home.value.setDirectory(homeDirectory);
  const questionId = unwrap(await work.value.ask({ threadId: "child", requestId: "ask-child", questions: [{ question: "North or South?", suggestions: ["North", "South"] }] })).questionIds[0]!;
  const original = unwrap(await work.value.questionState("child", questionId)).question;
  unwrap(await workDirectory.managerQuestionCustody({ action: "receive", threadId: "manager", requestId: "custody-ask:ask-child", originThreadId: "child", questions: [original], deadlineAt: original.createdAt + 2 * 60 * 60_000 }));
  const held = unwrap(await home.value.managerQuestions({ action: "list", threadId: "manager" }));
  expect(held).toMatchObject({ action: "list", questions: [{ id: questionId, threadId: "child", routing: "held" }] });
  expect(unwrap(await work.value.questions("child"))).toEqual([]);
  const forward = unwrap(await home.value.managerQuestions({ action: "forward", threadId: "manager", requestId: "forward", questionIds: [questionId], question: { question: "Which route?", suggestions: ["North", "South"] } }));
  if (forward.action !== "forward") throw Error("Expected forwarded question");
  unwrap(await workDirectory.managerQuestionCustody({ action: "transition", threadId: "child", requestId: `custody-forward:${questionId}:${forward.receipt.questionId}`, questionId, managerId: "manager", transition: { state: "forwarded", forwardedQuestionId: forward.receipt.questionId } }));
  unwrap(await home.value.managerQuestions({ action: "answer", threadId: "manager", requestId: "manager-answer", questionId, text: "North", selectedSuggestionIds: [] }));
  const answer = unwrap(await home.value.questionState("manager", questionId)).answer!;
  unwrap(await workDirectory.managerQuestionCustody({ action: "transition", threadId: "child", requestId: `custody-settle:${questionId}`, questionId, managerId: "manager", transition: { state: "answered", answer: { selectedSuggestionIds: [], text: answer.text, ...(answer.answeredBy ? { answeredBy: answer.answeredBy } : {}) } } }));
  expect(unwrap(await work.value.questionState("child", questionId)).answer).toMatchObject({ text: "North", answeredBy: { kind: "manager", threadId: "manager" } });
  expect(work.value.pending("child").filter(item => item.replyTo === questionId)).toHaveLength(1);
});
