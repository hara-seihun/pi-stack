import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService, threadHttp, createThreadClient, configuredPersonSpawnModel } from "pi-orchestrator/api";
import { rootConsentHandler } from "../../../apps/remote/server/root-consent";
import { createConsentBridge } from "../src/consent";
import { consentInboxId } from "../src/consent-contract";
import type { Person } from "../../../apps/remote/server/persons";

test("Martine notification/consent inboxes select her owner default; retries preserve original IDs and custody, other people unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-inboxes-"));
  const SOL = "openai-codex/gpt-6.1-sol", ASTRA = "openai-codex/gpt-6-astra";
  const people = ["martine", "alice"].map((user, index): Person => ({ version: 1, user, displayName: user, port: 19001+index,
    environment: { PI_REMOTE_PRIVATE_DIR: root, PI_REMOTE_PRIVATE_ID: user, ...(user === "martine" ? { PI_THREAD_DEFAULT_MODEL: SOL } : {}) } }));
  for (const person of people) writeFileSync(join(root, person.user+".json"), JSON.stringify(person));
  const owners = Object.fromEntries(people.map(person => [person.user, new ThreadService({ databasePath: join(root, person.user+".sqlite"), sessionsDir: join(root, person.user),
    capacity: { mode: "unmanaged" }, openSession: async () => { throw Error("Routing test must not start models"); },
    spawnDefaultModel: () => configuredPersonSpawnModel({ PI_REMOTE_PERSONS_DIR: root }, person.user),
    admitNewThread: settings => settings.model === ASTRA ? { ok: false, error: { code: "invalid_request", message: "Astra disabled" } } : { ok: true, value: undefined } })]));
  for (const owner of Object.values(owners)) spyOn(owner as any, "wake").mockImplementation(() => {});
  const router = rootConsentHandler({ capability: () => "c".repeat(64), persons: () => people,
    client: person => createThreadClient("http://fixture/v1/threads", async (input, init) => (await threadHttp(owners[person], new Request(input, init)))!) });
  let loseAck = true;
  const bridge = createConsentBridge("http://127.0.0.1:19880", "c".repeat(64), (async (input, init) => {
    const result = await router(new Request(input, init));
    if (loseAck && result?.ok) { loseAck = false; return new Response("fixture lost ACK", { status: 503 }); }
    return result!;
  }) as typeof fetch);
  try {
    const notification = { consentId: "11111111-1111-4111-a111-111111111111", person: "martine", text: "Synthetic routing proof" };
    expect(await bridge.notify!(notification)).toMatchObject({ ok: false });
    const notificationId = consentInboxId("notification:"+notification.consentId);
    expect(owners.martine.get(notificationId)?.settings.model).toBe(SOL);
    expect(owners.martine.pending(notificationId)).toHaveLength(1);
    // Even after a future preference update, retry is the already accepted receipt, not a new spawn.
    people[0].environment.PI_THREAD_DEFAULT_MODEL = "luna";
    writeFileSync(join(root, "martine.json"), JSON.stringify(people[0]));
    expect(await bridge.notify!(notification)).toMatchObject({ ok: true });
    expect(owners.martine.get(notificationId)?.settings.model).toBe(SOL);
    expect(owners.martine.pending(notificationId)).toHaveLength(1);
    people[0].environment.PI_THREAD_DEFAULT_MODEL = SOL;
    writeFileSync(join(root, "martine.json"), JSON.stringify(people[0]));
    const question = { consentId: "22222222-2222-4222-a222-222222222222", subject: "martine", text: "Synthetic consent routing proof" };
    loseAck = true; expect(await bridge.question(question)).toMatchObject({ ok: false });
    const questionId = consentInboxId(question.consentId);
    expect(owners.martine.get(questionId)?.settings.model).toBe(SOL);
    expect(await bridge.question(question)).toMatchObject({ ok: true });
    const questions = await owners.martine.questions(questionId);
    expect(questions.ok && questions.value.length).toBe(1);
    expect((await owners.martine.list()).ok && (await owners.martine.list() as any).value.threads.length).toBe(2);
    expect(await bridge.notify!({ ...notification, consentId: "33333333-3333-4333-a333-333333333333", person: "alice" })).toMatchObject({ ok: false });
    expect(await bridge.question({ ...question, consentId: "44444444-4444-4444-a444-444444444444", subject: "alice" })).toMatchObject({ ok: false });
    expect(await owners.alice.list()).toMatchObject({ ok: true, value: { threads: [] } });
  } finally { for (const owner of Object.values(owners)) await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
