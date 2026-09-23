import { expect, test } from "bun:test";
import { RouterAuth, resolveEndpoints, sessionUrl } from "./src/router-auth";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("person changes discard sessions and endpoint selection, including a prior person's saved session", () => {
  const people = storage(), tab = storage();
  people.setItem("pi-remote-person", "sybil");
  tab.setItem("pi-remote-session:sybil", "sybil-token");
  tab.setItem("pi-remote-session:owner", "owner-token");
  tab.setItem("pi-remote-environment:sybil", "cloud");
  tab.setItem("pi-remote-environment:owner", "cloud");
  const changes: string[] = [];
  const auth = new RouterAuth(people, tab, kind => changes.push(kind));
  expect(auth.session).toBe("sybil-token");
  auth.setPerson("owner");
  expect(auth.session).toBe("");
  expect(tab.getItem("pi-remote-session:sybil")).toBeNull();
  expect(tab.getItem("pi-remote-session:owner")).toBeNull();
  expect(tab.getItem("pi-remote-environment:sybil")).toBeNull();
  expect(tab.getItem("pi-remote-environment:owner")).toBeNull();
  expect(() => auth.accept("sybil", "late-unlock")).toThrow("selected person");
  auth.accept("owner", "new-token");
  auth.clear("sybil-token");
  expect(auth.session).toBe("new-token");
  expect(changes).toContain("person");
});

test("headers carry the session and reject person impersonation", () => {
  const auth = new RouterAuth(storage(), storage(), () => {});
  auth.setPerson("sybil");
  auth.accept("sybil", "opaque-token");
  expect(auth.headers({ "x-pi-remote-session": "stale", accept: "application/json" }).get("x-pi-remote-session")).toBe("opaque-token");
  expect(auth.headers(undefined, false).has("x-pi-remote-session")).toBe(false);
  expect(() => auth.headers({ "x-pi-remote-user": "owner" })).toThrow("authenticated person");
});

test("download tokens stay on router APIs, never external URLs or ordinary page links", () => {
  const origin = "https://remote.example/";
  expect(sessionUrl("/v1/files?path=a&user=owner&session=stale", origin, "token")).toBe("/v1/files?path=a&session=token");
  for (const external of ["https://outside.example/v1/files", "//outside.example/v1/files", "/meet.html"]) {
    expect(sessionUrl(external, origin, "token")).toBe(external);
  }
  expect(sessionUrl("https://router.test/v1/remotes/cloud/v1/files", "https://router.test/", "token", ["/v1/remotes/cloud"])).toBe("https://router.test/v1/remotes/cloud/v1/files?session=token");
});

test("endpoint discovery resolves only same-origin router prefixes and drops upstreams", () => {
  const result = resolveEndpoints([
    { id: "local", name: "Home", baseUrl: "", icon: "house", upstreams: { owner: "http://private" } },
    { id: "cloud", name: "Cloud", baseUrl: "/v1/remotes/cloud", icon: "cloud" },
  ], "https://router.example", "http://localhost/");
  expect(result).toEqual([
    { id: "local", name: "Home", baseUrl: "https://router.example", icon: "house" },
    { id: "cloud", name: "Cloud", baseUrl: "https://router.example/v1/remotes/cloud", icon: "cloud" },
  ]);
  for (const baseUrl of ["https://outside.example", "//outside.example", "/../outside", "/v1?session=secret", "/%2foutside", "/\\outside"]) {
    expect(() => resolveEndpoints([{ id: "bad", name: "Bad", baseUrl }], "", "https://router.example/")).toThrow("router prefix");
  }
});
