import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifeCoverage, LifeCoverageInput, LifeRequest, LifeSnapshot } from "../src/life-contract.js";
import { LifeStore } from "../src/life-store.js";
import { validateLifeRequest, validateLifeResponse } from "../src/life-validation.js";

const target = { scope: "self" } as const;
const actor = { person: "example-person", threadId: "example-thread" };
const earlier = "2026-10-01T08:00:00Z";
const later = "2026-10-01T08:00:36Z";
const expiresAt = "2026-10-02T08:00:00Z";
const coverage: LifeCoverageInput = { source: "example-source", state: "partial", checkedAt: earlier, reconciledAt: later, freshUntil: null, detail: "Example reconciliation", error: null, evidence: [] };
const write = (value: LifeCoverageInput, expectedRevision = 0): Extract<LifeRequest, { operation: "coverage-write" }> => ({ operation: "coverage-write", target, expectedRevision, coverage: value });
const response = (value: LifeCoverageInput) => ({ ok: true as const, value: { id: value.source, revision: 1, recordedAt: later, recordedBy: actor.person, threadId: actor.threadId, value } });

test("successful partial and complete coverage may have unknown freshness, independently of chronology", () => {
  for (const state of ["partial", "complete"] as const) {
    const request = write({ ...coverage, state, reconciledAt: earlier });
    expect(validateLifeRequest(request)).toEqual({ ok: true, value: request });
    expect(validateLifeResponse<LifeCoverage>(response(request.coverage), request)).toEqual(response(request.coverage));
  }
});

test.each([null, expiresAt])("source check may precede reconciliation completion with freshness %s", freshUntil => {
  for (const state of ["partial", "complete"] as const) {
    const request = write({ ...coverage, state, checkedAt: "2026-10-01T10:00:00+02:00", freshUntil });
    expect(validateLifeRequest(request)).toEqual({ ok: true, value: request });
    expect(validateLifeResponse<LifeCoverage>(response(request.coverage), request)).toEqual(response(request.coverage));
  }
});

test("later source checks retain earlier or unknown reconciliation and already-expired freshness", () => {
  for (const reconciledAt of [earlier, null]) {
    const request = write({ ...coverage, state: "inaccessible", checkedAt: later, reconciledAt, freshUntil: earlier, error: "Example unavailable source" });
    expect(validateLifeRequest(request)).toEqual({ ok: true, value: request });
    expect(validateLifeResponse<LifeCoverage>(response(request.coverage), request)).toEqual(response(request.coverage));
  }
});

test("coverage refuses malformed timestamps and fictional complete reconciliation without writing", () => {
  const db = new Database(":memory:");
  try {
    const life = new LifeStore(db);
    for (const value of [
      { ...coverage, checkedAt: "2026-02-30T08:00:00Z" },
      { ...coverage, reconciledAt: "2026-02-30T08:00:00Z" },
      { ...coverage, freshUntil: "2026-02-30T08:00:00Z" },
      { ...coverage, state: "complete" as const, reconciledAt: null },
      { ...coverage, state: "complete" as const, error: "Example failed reconciliation" },
    ]) {
      const request = write(value);
      expect(validateLifeRequest(request)).toMatchObject({ ok: false, error: "invalid-request" });
      expect(life.request(actor.person, actor, request)).toMatchObject({ ok: false, error: "invalid-request" });
      expect(validateLifeResponse(response(value), request)).toBeNull();
    }
    expect(db.query("SELECT COUNT(*) AS count FROM life_versions").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

test("both milestone orders and unknown reconciliation/freshness survive encrypted durable restart", () => {
  const root = mkdtempSync(join(tmpdir(), "life-coverage-"));
  const path = join(root, "coverage.sqlite3");
  let db = new Database(path);
  try {
    let life = new LifeStore(db);
    const records: LifeCoverage[] = [];
    for (const value of [
      coverage,
      { ...coverage, source: "later-check", checkedAt: later, reconciledAt: earlier },
      { ...coverage, source: "never-reconciled", checkedAt: later, reconciledAt: null },
    ]) {
      const request = write(value);
      const written = validateLifeResponse<LifeCoverage>(life.request(actor.person, actor, request), request);
      expect(written).toMatchObject({ ok: true, value: { revision: 1, value } });
      if (!written?.ok) throw new Error("Expected coverage write");
      records.push(written.value);
    }
    db.close();
    db = new Database(path);
    life = new LifeStore(db);
    const read: LifeRequest = { operation: "read", target };
    const loaded = validateLifeResponse<LifeSnapshot>(life.request(actor.person, actor, read), read);
    expect(loaded?.ok).toBe(true);
    if (!loaded?.ok) throw new Error("Expected coverage read");
    expect(loaded.value.entities).toEqual([]);
    expect(loaded.value.coverage.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(records.toSorted((a, b) => a.id.localeCompare(b.id)));
    expect(life.request(actor.person, actor, write(coverage))).toMatchObject({ ok: false, error: "conflict", currentRevision: 1 });
    expect(life.request(actor.person, actor, write({ ...coverage, reconciledAt: "not-a-timestamp" }, 1))).toMatchObject({ ok: false, error: "invalid-request" });
    expect(life.request(actor.person, actor, read)).toEqual(loaded);
    expect(db.query("SELECT COUNT(*) AS count FROM life_versions").get()).toEqual({ count: 3 });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
