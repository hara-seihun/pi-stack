import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredEnvironments, personEnvironments, publicEnvironments } from "./environments";
import type { Person } from "./persons";

const root = mkdtempSync(join(tmpdir(), "pi-environments-"));
const hostFile = join(root, "host.json");
const own = { PI_REMOTE_ENVIRONMENT_ID: "desk", PI_REMOTE_ENVIRONMENT_NAME: "Desk" };
const owner: Person = { version: 1, user: "owner", displayName: "Owner", port: 10000, unlock: { cipherDir: "/cipher", mountpoint: "/mount" }, environment: own };
afterAll(() => rmSync(root, { recursive: true, force: true }));

function config(environments: unknown) {
  writeFileSync(hostFile, JSON.stringify({ environments }));
  return configuredEnvironments(own, hostFile);
}

test("default is this host alone, and names are data", () => {
  expect(configuredEnvironments(own, hostFile)).toEqual([{ id: "desk", name: "Desk", baseUrl: "" }]);
  const endpoints = config([{ id: "desk", name: "My desk", icon: "home" }, { id: "lab", name: "Lab", icon: "cloud", upstreams: { owner: "http://127.0.0.1:10001" } }]);
  expect(publicEnvironments(personEnvironments(owner, endpoints, "desk"))).toEqual([{ id: "desk", name: "My desk", icon: "home", baseUrl: "" }]);
  expect(publicEnvironments(personEnvironments({ ...owner, remoteAccess: ["desk", "lab"] }, endpoints, "desk"))).toEqual([
    { id: "desk", name: "My desk", icon: "home", baseUrl: "" },
    { id: "lab", name: "Lab", icon: "cloud", baseUrl: "/v1/remotes/lab" },
  ]);
});

test("rejects ambiguous or bypass routes and missing local identity", () => {
  for (const entries of [[], [{ id: "desk" }, { id: "desk" }], [{ id: "Desk" }], [{ id: "desk", baseUrl: "" }], [{ id: "desk", upstreams: { owner: "http://localhost" } }], [{ id: "lab", upstreams: { owner: "http://localhost" } }]]) expect(() => config(entries)).toThrow();
  for (const upstream of ["file:///tmp/data", "https://user:secret@example.org", "https://example.org/path", "https://example.org?x=1"]) expect(() => config([{ id: "desk" }, { id: "lab", upstreams: { owner: upstream } }])).toThrow();
});

test("grants require a known endpoint, identity proof and that person's upstream", () => {
  const endpoints = config([{ id: "desk" }, { id: "lab", upstreams: { owner: "http://127.0.0.1:10001" } }]);
  for (const person of [
    { ...owner, remoteAccess: ["desk", "missing"] },
    { ...owner, remoteAccess: ["lab"] },
    { ...owner, unlock: undefined, remoteAccess: ["desk", "lab"] },
    { ...owner, user: "guest", remoteAccess: ["desk", "lab"] },
  ]) expect(() => personEnvironments(person, endpoints, "desk")).toThrow();
});
