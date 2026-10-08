import { expect, test } from "bun:test";
import { handleAgentSignal, isSignalProductPath } from "./agent-signal";

const people = new Map([[1001, "alice"], [1002, "bob"]]);
const owners = new Map([["alice", { user: "alice", port: 11001 }], ["bob", { user: "bob", port: 11002 }]]);

test("Signal tools choose only the kernel-UID owner, not headers or query identity", async () => {
  const calls: string[] = [];
  const proxy = async (person: { user: string }) => { calls.push(person.user); return Response.json({ person: person.user }); };
  const req = new Request("http://router/v1/agent-signal?user=bob", { headers: { "x-pi-remote-user": "bob", "x-pi-remote-session": "browser-token" } });
  const own = await handleAgentSignal(req, { uid: 1001 }, people, user => owners.get(user), proxy);
  expect(await own.json()).toEqual({ person: "alice" });
  for (const peer of [undefined, { uid: 0 }, { uid: 9999 }]) expect((await handleAgentSignal(req, peer, people, user => owners.get(user), proxy)).status).toBe(403);
  expect(calls).toEqual(["alice"]);
});

test("browser and environment proxy namespaces cannot reach Signal transport", () => {
  for (const path of ["/v1/messaging", "/v1/messaging/calls/a/audio", "/v1/agent-signal", "/v1/agent-signal/conversations/a/messages", "/v1/remotes/work/v1/agent-signal", "/v1/remotes/work/v1/messaging"]) expect(isSignalProductPath(path)).toBe(true);
  for (const path of ["/v1/rooms", "/v1/sessions/a", "/v1/remotes/work/v1/rooms", "/v1/agent-signal-other"]) expect(isSignalProductPath(path)).toBe(false);
});
