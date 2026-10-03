import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beginPublication, finishPublication } from "./action-journal.mjs";

test("publication boundary retains originating person across a service restart and flag-off is inert", () => {
  const root = mkdtempSync(join(tmpdir(), "kenan-publication-journal-"));
  const prior = { ...process.env };
  try {
    process.env.PI_STACK_HOST_CONFIG = join(root, "host.json");
    process.env.PI_KENAN_ACTION_JOURNAL_DIR = join(root, "receipts");
    process.env.PI_KENAN_ACTION_JOURNAL_CLI = resolve(import.meta.dir, "../packages/kenan-memory/src/journal-cli.ts");
    writeFileSync(process.env.PI_STACK_HOST_CONFIG, "{}");
    const request: any = { requestId: "PUB-fixture", sourceSha: "a".repeat(40), actionPerson: "alice", reporter: { sessionId: "alice-thread" } };
    expect(beginPublication(request, [{ id: "server" }])).toBeNull();
    expect(readdirSync(root)).toEqual(["host.json"]);
    writeFileSync(process.env.PI_STACK_HOST_CONFIG, '{"oneKenan":true}');
    request.actionJournal = beginPublication(request, [{ id: "server" }]);
    process.env.PI_KENAN_PERSON = "service-not-alice";
    request.integrationSha = "b".repeat(40);
    request.publishedAt = new Date().toISOString();
    finishPublication(request);
    const files = readdirSync(process.env.PI_KENAN_ACTION_JOURNAL_DIR);
    expect(files).toHaveLength(2);
    const item = JSON.parse(readFileSync(join(process.env.PI_KENAN_ACTION_JOURNAL_DIR, files.find(file => file.includes("confirmed"))!), "utf8"));
    expect(item.source.actedFor).toBe("alice");
    expect(item.setting.threadId).toBe("alice-thread");
    expect(item.text).toContain(request.integrationSha);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    rmSync(root, { recursive: true, force: true });
  }
});
