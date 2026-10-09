import { expect, test } from "bun:test";
import { createManagerRequest } from "./src/app/manager-request";
import type { Endpoint } from "./src/router-auth";

const environments: Endpoint[] = [
  { id: "local", name: "Personal", icon: "house", baseUrl: "https://router.test/pi-stack" },
  { id: "work", name: "Work", icon: "cloud", baseUrl: "https://router.test/pi-stack/v1/environments/work" },
];
const preference = { view: "mono", managerThreadId: "manager", hintSeen: true };

function fixture(fetcher: (url: string, options: RequestInit) => Promise<Response>) {
  let identity = { user: "person", session: "private-session" };
  const cleared: string[] = [];
  const request = createManagerRequest({
    identity: () => identity, environments: async () => environments,
    headers: initial => { const headers = new Headers(initial); headers.set("x-pi-remote-user", identity.user); headers.set("x-pi-remote-session", identity.session); return headers; },
    fetch: fetcher, clearSession: session => cleared.push(session),
  });
  return { request, changeIdentity: () => { identity = { user: "other", session: "different-session" }; }, cleared };
}

test("reads and saves the authorized owner URL, never the currently selected Work endpoint", async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const { request } = fixture(async (url, options) => { requests.push({ url, options }); return Response.json(preference); });
  expect(await request("local")).toEqual({ ok: true, value: preference });
  expect(await request("local", { view: "mono", hintSeen: true })).toEqual({ ok: true, value: preference });
  expect(requests.map(item => item.url)).toEqual(["https://router.test/pi-stack/v1/manager", "https://router.test/pi-stack/v1/manager"]);
  expect(requests.map(item => item.options.method)).toEqual(["GET", "POST"]);
  expect(requests[1]!.options.body).toBe('{"view":"mono","hintSeen":true}');
  expect(new Headers(requests[1]!.options.headers).get("x-pi-remote-session")).toBe("private-session");
  expect(requests[0]!.options.redirect).toBe("error");
});

test("an unauthorized manager owner has no request or fabricated classic preference", async () => {
  let requests = 0;
  const { request } = fixture(async () => { requests++; return Response.json(preference); });
  const result = await request("ungranted");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.kind).toBe("owner_unavailable");
  expect(requests).toBe(0);
});

test("late reads cannot cross identity changes, and malformed or unsaved responses are errors", async () => {
  const owner = fixture(async () => { owner.changeIdentity(); return Response.json(preference); });
  const changed = await owner.request("local");
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.error.kind).toBe("identity_changed");
  for (const value of [{ ...preference, managerThreadId: null }, { ...preference, hintSeen: false }, { view: "classic", managerThreadId: null, hintSeen: false }]) {
    const { request } = fixture(async () => Response.json(value));
    const result = await request("local", { view: "mono", hintSeen: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  }
});

test("owner failures preserve an explicit error and rejected sessions are cleared", async () => {
  const locked = fixture(async () => Response.json({ error: "locked" }, { status: 423 }));
  expect((await locked.request("local")).ok).toBe(false);
  expect(locked.cleared).toEqual(["private-session"]);
  const failed = fixture(async () => { throw new Error("Owner unreachable"); });
  const result = await failed.request("local");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toEqual({ kind: "request_failed", message: "Owner unreachable" });
});
