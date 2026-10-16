import { expect, test } from "bun:test";
import { parseCoreConfig } from "../src/core/config.js";
import { openSqlite } from "../src/sqlite.js";
import { CoreManagerNotices } from "../src/core/manager-notices.js";
import type { CoreConfig, CoreScope } from "../src/core/contracts.js";
import { CALLBACK_SOURCE_SCOPE, CALLBACK_TARGET_SCOPE, CALLBACK_PRINCIPAL, scopeCallbackTarget, scopeCallbackTransport, validateScopeCallbacks } from "../src/core/scope-callbacks.js";

function fixture() {
  const scope = (id: string): CoreScope => ({
    id, principalId: "alice", availability: { kind: "adopt" },
    resource: { id: `${id}:threads`, kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" },
    storage: { databasePath: `/fixture/${id}/threads.sqlite3`, sessionsDir: `/fixture/${id}/sessions`, capabilityKeyPath: `/fixture/${id}/key`, adoptionReceiptPath: `/fixture/${id}/receipt.json` },
    custody: { uid: 1001, gid: 1001, namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: `/fixture/${id}`, socketDir: `/fixture/${id}` }, resources: [],
    environment: { PI_REMOTE_SERVER_URL: "http://127.0.0.1:18800" }, callbackGateway: { kind: "remote-callback", peerUid: 1001 }, manager: { kind: "none" }, managerRouting: { kind: "none" },
  });
  const remote = scope("remote:alice"), fleet = scope("fleet:alice");
  remote.custody.namespace = { kind: "pinned", path: "/fixture/remote.mount", mountNamespaceInode: "1234" };
  fleet.callbackGateway = { kind: "shared-remote-callback", targetScopeId: remote.id, peerUid: 1001 };
  const config: CoreConfig = { version: 1, host: "127.0.0.1", port: 19181, statePath: "/fixture/core.sqlite3", releaseCommit: "a".repeat(40), principals: [{ kind: "person", id: "alice", person: "alice" }, { kind: "person", id: "bob", person: "bob" }], credentials: [], policy: { revision: 1, grants: [], consents: [] }, scopes: [fleet, remote], broker: { kind: "disabled" }, root: { kind: "disabled" }, memory: { kind: "disabled" }, images: { kind: "disabled" }, duties: { kind: "disabled" }, callbacks: { kind: "none" }, gatewayTransport: { kind: "none" }, gatewayBindings: [] };
  return { config, fleet, remote };
}

test("fleet callback explicitly selects the existing same-owner Remote adapter despite a distinct data namespace", async () => {
  const f = fixture();
  expect(parseCoreConfig(f.config).ok).toBe(true);
  expect(scopeCallbackTarget(f.config.scopes, f.fleet)).toEqual({ ok: true, value: { scopeId: f.remote.id, peerUid: 1001, socketPath: "/run/pi-stack/gateways/remote-remote:alice/callback.sock" } });
  const original = JSON.stringify({ input: { threadId: "original", requestId: "native-receipt", text: "same bytes" }, environmentId: "converge" });
  let calls = 0;
  const transport = scopeCallbackTransport(f.config.scopes, f.fleet, async (peer, input, init) => {
    calls++;
    expect(peer).toEqual({ socketPath: "/run/pi-stack/gateways/remote-remote:alice/callback.sock", peerUid: 1001 });
    expect(String(input)).toBe("http://127.0.0.1:18800/v1/core/manager-relay/send");
    expect(init?.body).toBe(original);
    expect(new Headers(init?.headers).get(CALLBACK_SOURCE_SCOPE)).toBe(f.fleet.id);
    expect(new Headers(init?.headers).get(CALLBACK_TARGET_SCOPE)).toBe(f.remote.id);
    expect(new Headers(init?.headers).get(CALLBACK_PRINCIPAL)).toBe("alice");
    return Response.json({ ok: true, value: { id: "same-receipt" } });
  });
  expect(await (await transport("http://127.0.0.1:18800/v1/core/manager-relay/send", { method: "POST", body: original })).json()).toEqual({ ok: true, value: { id: "same-receipt" } });
  expect(calls).toBe(1);
});

test("shared callbacks cannot cross owner, principal, subjects, privacy, UID/GID, peer or exact Remote origin", () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.remote.principalId = "bob"; }, f => { f.remote.resource.owner = "bob"; },
    f => { f.remote.resource.subjects = ["bob"]; }, f => { f.remote.resource.privacy = "confidential"; },
    f => { f.remote.custody.uid++; }, f => { f.remote.custody.gid++; },
    f => { f.remote.callbackGateway = { kind: "remote-callback", peerUid: 1002 }; },
    f => { f.remote.environment.PI_REMOTE_SERVER_URL = "http://127.0.0.1:18801"; },
    f => { f.fleet.callbackGateway = { kind: "shared-remote-callback", targetScopeId: "unknown", peerUid: 1001 }; },
    f => { f.fleet.callbackGateway = { kind: "shared-remote-callback", targetScopeId: f.fleet.id, peerUid: 1001 }; },
    f => { f.remote.callbackGateway = { kind: "shared-remote-callback", targetScopeId: f.fleet.id, peerUid: 1001 }; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    expect(validateScopeCallbacks(f.config.scopes).ok).toBe(false);
    expect(parseCoreConfig(f.config).ok).toBe(false);
  }
  const f = fixture();
  expect(parseCoreConfig({ ...f.config, scopes: [{ ...f.fleet, callbackGateway: { ...f.fleet.callbackGateway, socketPath: "/forged.sock" } }, f.remote] }).ok).toBe(false);
});

test("inactive Remote keeps adopted fleet callbacks paused without constructing or contacting an endpoint", async () => {
  const f = fixture();
  f.remote.availability = { kind: "unavailable", reason: "inactive" };
  f.remote.callbackGateway = { kind: "none" };
  f.remote.environment = {};
  expect(parseCoreConfig(f.config).ok).toBe(true);
  expect(scopeCallbackTarget(f.config.scopes, f.fleet)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  let sent = false;
  const transport = scopeCallbackTransport(f.config.scopes, f.fleet, async () => { sent = true; throw new Error("Paused callback must never send"); });
  const response = await transport("http://127.0.0.1:18800/v1/core/prepare-message", { method: "POST", body: "original" });
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("unavailable");
  expect(sent).toBe(false);
  f.remote.availability = { kind: "adopt" };
  expect(parseCoreConfig(f.config).ok).toBe(false);
  f.remote.callbackGateway = { kind: "remote-callback", peerUid: 1001 };
  f.remote.environment.PI_REMOTE_SERVER_URL = "http://127.0.0.1:18800";
  expect(parseCoreConfig(f.config).ok).toBe(true);
  expect(scopeCallbackTarget(f.config.scopes, f.fleet).ok).toBe(true);
});

test("paused callback policy preserves adopted fleet notice watermarks and immutable pending outbox", async () => {
  const f = fixture();
  f.remote.availability = { kind: "unavailable", reason: "inactive" };
  f.remote.callbackGateway = { kind: "none" };
  const db = openSqlite(":memory:");
  let scans = 0;
  const forbidden = async () => { scans++; throw new Error("Paused owner must not scan and discard receipts as classic"); };
  const notices = new CoreManagerNotices({ scopeId: f.fleet.id, notificationOwnerId: "fleet", adoptedCursors: { settlements: 22579, attention: 9, questions: 7870 }, subscribe: () => () => {}, feedback: () => {} }, db, { settlements: forbidden, attentionEvents: forbidden, questionEvents: forbidden, list: forbidden }, {
    managerNotificationPolicy: async () => {
      const callback = scopeCallbackTarget(f.config.scopes, f.fleet);
      if (!callback.ok) return { ok: false, error: { code: "unavailable", message: callback.error.message } };
      throw new Error("Unavailable target cannot become a manager policy");
    }, send: forbidden,
  });
  const original = JSON.stringify({ threadId: "original-manager", requestId: "manager-notice:fleet:settlement:original", text: "original receipt bytes" });
  db.prepare("INSERT INTO core_manager_notice_outbox VALUES(?,?,?,NULL)").run(f.fleet.id, "manager-notice:fleet:settlement:original", original);
  try {
    expect((await notices.start()).ok).toBe(false);
    expect(scans).toBe(0);
    expect(db.prepare("SELECT kind,cursor FROM core_manager_notice_cursor ORDER BY kind").all()).toEqual([{ kind: "attention", cursor: 9 }, { kind: "questions", cursor: 7870 }, { kind: "settlements", cursor: 22579 }]);
    expect(db.prepare("SELECT input,error FROM core_manager_notice_outbox").get()).toEqual({ input: original, error: null });
  } finally { await notices.close(); db.close(); }
});

test("the owncallback variant preserves its socket and does not promote supplied source claims", async () => {
  const f = fixture();
  const transport = scopeCallbackTransport(f.config.scopes, f.remote, async (peer, _input, init) => {
    expect(peer.socketPath).toBe("/run/pi-stack/gateways/remote-remote:alice/callback.sock");
    for (const name of [CALLBACK_SOURCE_SCOPE, CALLBACK_TARGET_SCOPE, CALLBACK_PRINCIPAL]) expect(new Headers(init?.headers).has(name)).toBe(false);
    return new Response();
  });
  await transport("http://remote/v1/core/prepare-message", { headers: { [CALLBACK_SOURCE_SCOPE]: "forged", [CALLBACK_TARGET_SCOPE]: "another", [CALLBACK_PRINCIPAL]: "bob" } });
});
