import { expect, test } from "bun:test";
import { EditorAccess, editorOriginAllowed } from "./editor-access";
import { RouterSessions } from "./router-sessions";
import { parsePerson, type Person } from "./persons";

const person = (user: string): Person => ({ version: 1, user, displayName: user, port: 19000, environment: {}, unlock: { cipherDir: `/home/${user}/.crypt`, mountpoint: `/home/${user}/private` }, editor: { workspace: `/home/${user}/private/workspace`, origin: `http://${user}-editor.example` } });
const appRequest = new Request("http://pi.example/v1/editor", { headers: { origin: "https://attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" } });
const request = (cookie: string) => new Request("http://alice-editor.example/", { headers: { cookie } });

test("handoff is one-use, person-bound, URL-secret-free and revoked with its app session", () => {
  const sessions = new RouterSessions();
  const access = new EditorAccess(sessions);
  const alice = person("alice");
  const token = sessions.issue("alice");
  const handoff = access.issue(alice, token, "/home/alice/private/notes.md", "file", appRequest, null);
  expect(handoff.ok).toBe(true);
  if (!handoff.ok) return;
  expect(new URL(handoff.url).search).toBe("");
  expect(handoff.url).not.toContain(handoff.ticket);
  const grant = access.consume(alice, handoff.ticket);
  expect(grant.ok).toBe(true);
  if (!grant.ok) return;
  expect(grant.location).toBe("/?file=%2Fhome%2Falice%2Fprivate%2Fnotes.md");
  expect(access.consume(alice, handoff.ticket).ok).toBe(false);
  const identity = access.authenticate(alice, request(grant.cookie));
  expect(identity).toMatchObject({ ok: true, parentOrigin: "http://pi.example" });
  expect(grant.cookie).toContain("SameSite=Lax");
  expect(grant.cookie).not.toContain("Secure");
  expect(access.authenticate(person("bob"), request(grant.cookie))).toMatchObject({ ok: false, status: 403 });
  sessions.revoke("alice");
  if (identity.ok) expect(identity.signal.aborted).toBe(true);
  expect(access.authenticate(alice, request(grant.cookie))).toMatchObject({ ok: false, status: 423 });
});

test("identity switch closes grants and pending tickets, and wrong-person session cannot launch", () => {
  const sessions = new RouterSessions();
  const access = new EditorAccess(sessions);
  const alice = person("alice");
  const token = sessions.issue("alice");
  expect(access.issue(person("bob"), token, null, "directory", appRequest, null).ok).toBe(false);
  const first = access.issue(alice, token, null, "directory", appRequest, null);
  if (!first.ok) throw new Error(first.error);
  const grant = access.consume(alice, first.ticket);
  if (!grant.ok) throw new Error(grant.error);
  const identity = access.authenticate(alice, request(grant.cookie));
  const pending = access.issue(alice, token, null, "directory", appRequest, null);
  if (!pending.ok) throw new Error(pending.error);
  access.close(token);
  if (identity.ok) expect(identity.signal.aborted).toBe(true);
  expect(access.consume(alice, pending.ticket).ok).toBe(false);
  expect(access.authenticate(alice, request(grant.cookie)).ok).toBe(false);
});

test.each([
  ["http://alice-editor.mesh.test", "http://pi.mesh.test/v1/editor", null, "http://pi.mesh.test", "Lax", false],
  ["https://alice-editor.example.org", "https://pi.example.net/v1/editor", null, "https://pi.example.net", "None", true],
  ["https://alice-editor.example.org", "http://internal-router/v1/editor", "https://pi.example.net/pi-stack/", "https://pi.example.net", "None", true],
] as const)("parent authority and iframe cookie are explicit for %s", (editorOrigin, requestUrl, publicUrl, expectedParent, sameSite, secure) => {
  const sessions = new RouterSessions();
  const access = new EditorAccess(sessions);
  const alice = { ...person("alice"), editor: { workspace: "/home/alice/private", origin: editorOrigin } };
  const handoff = access.issue(alice, sessions.issue("alice"), null, "directory", new Request(requestUrl, {
    headers: { origin: "https://attacker.test", "x-forwarded-proto": "https", "x-forwarded-host": "attacker.test" },
  }), publicUrl);
  if (!handoff.ok) throw new Error(handoff.error);
  const grant = access.consume(alice, handoff.ticket);
  if (!grant.ok) throw new Error(grant.error);
  expect(grant.cookie).toContain(`SameSite=${sameSite}`);
  expect(grant.cookie.includes("Secure")).toBe(secure);
  expect(access.authenticate(alice, request(grant.cookie))).toMatchObject({ ok: true, parentOrigin: expectedParent });
  sessions.revoke("alice");
});

test("editor configuration requires an encrypted-contained workspace and canonical separate origin", () => {
  const valid = person("alice");
  expect(parsePerson(JSON.stringify(valid), "fixture").editor).toEqual(valid.editor);
  for (const editor of [{ workspace: "/etc", origin: "http://alice-editor.example" }, { workspace: valid.editor!.workspace, origin: "http://alice-editor.example/?key=secret" }]) expect(() => parsePerson(JSON.stringify({ ...valid, editor }), "fixture")).toThrow();
  expect(() => parsePerson(JSON.stringify({ ...valid, unlock: undefined }), "fixture")).toThrow();
  expect(editorOriginAllowed(new Request("http://alice-editor.example/", { headers: { origin: "http://bob-editor.example" } }), valid)).toBe(false);
  expect(editorOriginAllowed(new Request("http://alice-editor.example/", { headers: { origin: valid.editor!.origin } }), valid)).toBe(true);
});
