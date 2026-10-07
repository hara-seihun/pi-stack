import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importArguments, importMarkdown, markdownImportEntries } from "./life-import.js";
import { validateLifeRequest } from "../packages/kenan-memory/src/life-validation.js";
import type { LifeClient, LifeEntityInput, LifeImportReceipt, LifeRequest, LifeResult, LifeValue } from "../packages/kenan-memory/src/life-contract.js";

const observedAt = "2026-01-12T10:00:00.000Z";
const options = { source: "/fixture/tasks.md", needsHeading: "Needs Operator" };
const fixture = [
  "# Tasks", "## Needs Operator", "- [ ] Choose the delivery option", "- [x] An already closed action", "  closed detail",
  "- Confirm the address", "", "Provide the missing access code.", "This is the same prose item.", "",
  "### Details", "1. Supply the document", "## Agent work", "- [ ] Prepare the report", "  Preserve this continuation.",
  "- [X] A completed report", "- This is context, not a commitment", "", "```markdown", "- [ ] This is a code example", "```", "",
  "## Needs Someone Else", "- [ ] Draft the schedule due: 2026-02-03T18:00:00+02:00", "- [ ] Follow up next Friday", "",
].join("\r\n");

function parse(text = fixture) {
  const parsed = markdownImportEntries(Buffer.from(text), options, observedAt);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

test("needs section imports prose and open items as linked needs, while agent checkboxes remain commitments", () => {
  const { entries, fingerprint } = parse();
  const commitments = entries.filter(entry => entry.entity.kind === "commitment");
  const needs = entries.filter(entry => entry.entity.kind === "needs-you");
  expect(commitments).toHaveLength(7);
  expect(needs).toHaveLength(4);
  expect(needs.map(entry => entry.entity.title)).toEqual([
    "Choose the delivery option", "Confirm the address", "Provide the missing access code.\nThis is the same prose item.", "Supply the document",
  ]);
  for (const { entity } of needs) {
    if (entity.kind !== "needs-you") throw new Error("Unexpected kind");
    const linked = commitments.find(entry => entry.id === entity.commitmentId)!.entity;
    expect(linked.kind === "commitment" && linked.state === "waiting" && linked.owner.kind === "kenan" && linked.waiting?.for === "person").toBe(true);
  }
  const report = commitments.find(entry => entry.entity.title.startsWith("Prepare the report"))!.entity;
  expect(report.kind === "commitment" && report.state === "proposed" && report.authority === null && report.waiting === null).toBe(true);
  expect(report.provenance.source.locator).toBe("/fixture/tasks.md#L14-L15");
  expect(report.kind === "commitment" && report.origin).toBe("- [ ] Prepare the report\r\n  Preserve this continuation.\r\n");
  expect(report.provenance.factClass).toBe("stated");
  expect(report.provenance.source.actor).toBeNull();
  expect(report.provenance.evidence[0]!.id).toBe(`sha256:${fingerprint}`);
  expect(fingerprint).toBe(createHash("sha256").update(Buffer.from(fixture)).digest("hex"));
  expect(validateLifeRequest({ operation: "import-entities", target: { scope: "self" }, source: options.source, fingerprint, entries }).ok).toBe(true);
});

test("only explicit valid timestamp deadlines are parsed; no relative or date-only inference", () => {
  const entries = parse().entries;
  const schedule = entries.find(entry => entry.entity.title.startsWith("Draft the schedule"))!.entity;
  expect(schedule.kind === "commitment" && schedule.due).toEqual({ at: "2026-02-03T16:00:00.000Z", timeZone: "UTC" });
  const followup = entries.find(entry => entry.entity.title.startsWith("Follow up"))!.entity;
  expect(followup.kind === "commitment" && followup.due).toBeNull();
  for (const phrase of ["due: 2026-02-30T10:00:00Z", "due: 2026-02-03", "due: 2026-02-03T10:00:00Z and due: 2026-02-04T10:00:00Z"]) {
    const entity = parse(`- [ ] Do the action ${phrase}`).entries[0]!.entity;
    expect(entity.kind === "commitment" && entity.due).toBeNull();
  }
});

test("stable source IDs, UTF-8 evidence, strict CLI options, and empty source are defined", () => {
  expect(parse().entries.map(entry => entry.id)).toEqual(parse().entries.map(entry => entry.id));
  expect(parse("# Completed\n- [x] Finished\n").entries).toEqual([]);
  expect(markdownImportEntries(new Uint8Array([0xff]), options, observedAt)).toMatchObject({ ok: false, error: "invalid-source" });
  expect(importArguments(["--source", "relative.md", "--needs-heading", "Needs Operator"])).toMatchObject({ ok: false, error: "invalid-options" });
  expect(importArguments(["--source", options.source, "--needs-heading", options.needsHeading, "--person", "claimed"])).toMatchObject({ ok: false, error: "invalid-options" });
  expect(importArguments(["--source", options.source, "--needs-heading", options.needsHeading])).toEqual({ ok: true, value: options });
});

test("one-time receipt short-circuits reruns even after source edits/deletion, and never writes source bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "life-import-test-"));
  const source = join(directory, "tasks.md");
  const localOptions = { ...options, source };
  const before = Buffer.from(fixture);
  const entities = new Map<string, LifeEntityInput>();
  let receipt: LifeImportReceipt | null = null;
  const operations: string[] = [];
  const client: LifeClient = {
    async request<T = LifeValue>(request: LifeRequest): Promise<LifeResult<T>> {
      operations.push(request.operation);
      if (request.operation === "import-receipt") return receipt
        ? { ok: true, value: { ...receipt, status: "already-imported" } as T }
        : { ok: false, error: "not-found", message: "No import receipt" };
      if (request.operation !== "import-entities") throw new Error("Unexpected importer request");
      if (receipt) throw new Error("The importer resubmitted a completed import");
      for (const entry of request.entries) entities.set(entry.id, entry.entity);
      receipt = { source: request.source, fingerprint: request.fingerprint, importedAt: observedAt, ids: request.entries.map(entry => entry.id), status: "imported" };
      return { ok: true, value: receipt as T };
    },
  };
  try {
    await writeFile(source, before);
    const first = await importMarkdown(localOptions, client, observedAt);
    expect(first.ok && first.value.status).toBe("imported");
    expect(await readFile(source)).toEqual(before);
    const [id, current] = [...entities].find(([, entity]) => entity.kind === "needs-you")!;
    if (current.kind !== "needs-you") throw new Error("Unexpected kind");
    entities.set(id, { ...current, state: "resolved" });
    const changed = Buffer.from("## Needs Operator\n- [ ] A completely different item\n");
    await writeFile(source, changed);
    const second = await importMarkdown(localOptions, client, observedAt);
    expect(second.ok && second.value).toEqual(first.ok ? { ...first.value, status: "already-imported" } : null);
    expect(await readFile(source)).toEqual(changed);
    await unlink(source);
    expect((await importMarkdown(localOptions, client, observedAt)).ok).toBe(true);
    expect(operations).toEqual(["import-receipt", "import-entities", "import-receipt", "import-receipt"]);
    expect(entities.get(id)?.kind === "needs-you" && (entities.get(id) as { state: string }).state).toBe("resolved");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
