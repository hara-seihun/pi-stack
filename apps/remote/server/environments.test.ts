import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownEnvironments } from "./environments";

const root = mkdtempSync(join(tmpdir(), "pi-environments-"));
const hostFile = join(root, "host.json");
const own = { PI_REMOTE_ENVIRONMENT_ID: "work", PI_REMOTE_ENVIRONMENT_NAME: "Work" };
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a host without remote routes advertises itself", () => {
  expect(knownEnvironments(own, hostFile)).toEqual([{ id: "work", name: "Work", baseUrl: "" }]);
  writeFileSync(hostFile, JSON.stringify({ version: 1, fleetUser: "kenan" }));
  expect(knownEnvironments(own, hostFile)).toEqual([{ id: "work", name: "Work", baseUrl: "" }]);
});

test("rejects ambiguous ids and routes that leave the serving origin", () => {
  for (const environments of [[], [{ id: "work" }, { id: "work" }], [{ id: "Work" }], [{ id: "work", baseUrl: "https://example.org" }], [{ id: "work", baseUrl: "//example.org/work" }]]) {
    writeFileSync(hostFile, JSON.stringify({ environments }));
    expect(() => knownEnvironments(own, hostFile)).toThrow();
  }
});
