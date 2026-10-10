import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createModelBroker, validateBrokerConfig } from "../src/model-broker.js";
import { noModelPolicy } from "./fixtures/model-availability.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "broker-grant-owner-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.sqlite3"), authPath = join(root, "auth.json");
  const store = Store.open(ledgerPath);
  cleanup.push(() => store.close());
  return { ledgerPath, authPath, store };
}
const grant = (principal: string) => ({ principal, accounts: ["fixture-pool"], models: ["openai-codex/gpt-6.1-sol"] });

test("independent root broker never replaces ordinary grants, even across reload and rollback", async () => {
  const f = fixture();
  f.store.publishBrokerGrants([grant("alice")]);
  const root = createModelBroker({ ledgerPath: f.ledgerPath, authPath: f.authPath, grantOwner: "one-kenan", listeners: [{
    ...grant("pi-kenan"), port: 0, maxInFlight: 2,
  }] }, noModelPolicy);
  cleanup.push(() => root.close());
  const [port] = await root.listen();
  expect(port).toBeGreaterThan(0);
  expect(f.store.brokerGrant("alice")).toEqual({ accounts: ["fixture-pool"], models: ["openai-codex/gpt-6.1-sol"] });
  expect(f.store.brokerGrant("pi-kenan")).toBeDefined();
  f.store.publishBrokerGrants([grant("alice"), grant("bob")]);
  expect(f.store.brokerGrant("pi-kenan")).toBeDefined();
  root.applyGrants([{ ...grant("pi-kenan"), port, maxInFlight: 2, accounts: ["updated-pool"] }]);
  expect(f.store.brokerGrant("alice")).toBeDefined();
  expect(f.store.brokerGrant("bob")).toBeDefined();
  expect(f.store.brokerGrant("pi-kenan")?.accounts).toEqual(["updated-pool"]);
  f.store.publishBrokerGrants([], "one-kenan");
  expect(f.store.brokerGrant("pi-kenan")).toBeUndefined();
  expect(f.store.brokerGrant("alice")).toBeDefined();
  expect(f.store.brokerGrant("bob")).toBeDefined();
});

test("grant owner cannot steal a principal and collision rolls back its whole reconciliation", () => {
  const { store } = fixture();
  store.publishBrokerGrants([grant("alice")]);
  expect(() => store.publishBrokerGrants([grant("pi-kenan"), grant("alice")], "one-kenan")).toThrow("another grant owner");
  expect(store.brokerGrant("pi-kenan")).toBeUndefined();
  expect(store.brokerGrant("alice")).toBeDefined();
  store.publishBrokerGrants([grant("pi-kenan")], "one-kenan");
  expect(() => store.publishBrokerGrants([grant("pi-kenan")])).toThrow("another grant owner");
  store.publishBrokerGrants([]);
  expect(store.brokerGrant("alice")).toBeUndefined();
  expect(store.brokerGrant("pi-kenan")).toBeDefined();
});

test("broker grant ownership is optional but explicitly named scopes are validated", () => {
  const config = { ledgerPath: "/fixture/ledger", authPath: "/fixture/auth", listeners: [{ ...grant("alice"), port: 2480, maxInFlight: 2 }] };
  expect(validateBrokerConfig(config)).toBe(true);
  expect(validateBrokerConfig({ ...config, grantOwner: "one-kenan" })).toBe(true);
  expect(validateBrokerConfig({ ...config, grantOwner: ["one-kenan"] })).toBe(false);
  expect(validateBrokerConfig({ ...config, grantOwner: "" })).toBe(false);
});
