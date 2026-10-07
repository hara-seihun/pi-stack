import { expect, test } from "bun:test";
import type { Result } from "pi-orchestrator/api";
import type { QuestionsResource, ThreadQuestion } from "./protocol";
import { QuestionFeed } from "./question-feed";
import { ClientStream } from "./stream";
import { ReconcileReplica, type ReconcileFrame } from "../shared/reconcile";

function recording(sessionId = "thread") {
  const snapshots: QuestionsResource[] = [];
  const replica = new ReconcileReplica();
  const stream = new ClientStream({ close() {}, write(chunk) {
    if (!chunk.startsWith("event: reconcile")) return;
    const result = replica.apply(JSON.parse(chunk.split("data: ")[1]) as ReconcileFrame);
    if (!result.ok) throw new Error("Invalid question reconciliation");
    snapshots.push(result.value as QuestionsResource);
  } });
  stream.declare({ session: sessionId, want: [`questions:${sessionId}`] });
  return { stream, snapshots };
}

function deferred() {
  let resolve!: (result: Result<ThreadQuestion[]>) => void;
  const promise = new Promise<Result<ThreadQuestion[]>>(complete => { resolve = complete; });
  return { promise, resolve };
}
const question: ThreadQuestion = { id: "question", threadId: "thread", question: "When?", createdAt: 1, suggestions: [] };

test("routine refreshes never reset a settled question resource to loading or emit unchanged frames", async () => {
  for (const questions of [[], [question]]) {
    let read = deferred();
    let calls = 0;
    const feed = new QuestionFeed(() => { calls++; return read.promise; });
    const first = recording();
    const second = recording();
    const opening = Promise.all([feed.send(first.stream), feed.send(second.stream)]);
    expect(calls).toBe(1);
    expect(first.snapshots.map(snapshot => snapshot.state)).toEqual(["loading"]);
    read.resolve({ ok: true, value: questions });
    await opening;
    expect(first.snapshots.map(snapshot => snapshot.state)).toEqual(["loading", "ready"]);
    for (let i = 0; i < 5; i++) {
      read = deferred();
      const refresh = feed.send(first.stream);
      expect(first.snapshots).toHaveLength(2);
      read.resolve({ ok: true, value: questions });
      await refresh;
      expect(first.snapshots).toHaveLength(2);
    }
    read = deferred();
    const finite = recording();
    const selection = feed.send(finite.stream).then(() => finite.stream.close());
    expect(finite.snapshots).toHaveLength(0);
    read.resolve({ ok: true, value: questions });
    await selection;
    expect(finite.snapshots.map(snapshot => snapshot.state)).toEqual(["ready"]);
    expect(finite.snapshots[0].questions).toEqual(questions);
  }
});

test("failures preserve questions, stay settled during retries, and recover without a loading transition", async () => {
  let read: () => Promise<Result<ThreadQuestion[]>> = async () => ({ ok: true, value: [question] });
  const feed = new QuestionFeed(() => read());
  const { stream, snapshots } = recording();
  await feed.send(stream);
  read = async () => ({ ok: false, error: { code: "unavailable", message: "Owner unavailable" } });
  await feed.send(stream);
  expect(snapshots.at(-1)).toMatchObject({ state: "failed", questions: [question], error: "Owner unavailable" });
  const retry = deferred();
  read = () => retry.promise;
  const recovery = feed.send(stream);
  expect(snapshots.at(-1)?.state).toBe("failed");
  retry.resolve({ ok: true, value: [] });
  await recovery;
  expect(snapshots.map(snapshot => snapshot.state)).toEqual(["loading", "ready", "failed", "ready"]);
  expect(snapshots.at(-1)?.questions).toEqual([]);
  read = async () => { throw new Error("Transport rejected"); };
  await feed.send(stream);
  expect(snapshots.at(-1)).toMatchObject({ state: "failed", error: "Transport rejected" });
});

test("an answer refresh never republishes the cached answered question, and departed streams get no late result", async () => {
  let read = deferred();
  const feed = new QuestionFeed(() => read.promise);
  const { stream, snapshots } = recording();
  const initial = feed.send(stream);
  read.resolve({ ok: true, value: [question] });
  await initial;
  read = deferred();
  const old = feed.send(stream);
  const settling = feed.settle("thread");
  read.resolve({ ok: true, value: [question] });
  await settling;
  await old;
  read = deferred();
  const answered = feed.send(stream);
  expect(snapshots).toHaveLength(2);
  read.resolve({ ok: true, value: [] });
  await answered;
  expect(snapshots.at(-1)?.questions).toEqual([]);
  read = deferred();
  const departed = feed.send(stream);
  stream.declare({ session: "other" });
  read.resolve({ ok: true, value: [question] });
  await departed;
  expect(snapshots).toHaveLength(3);
});
