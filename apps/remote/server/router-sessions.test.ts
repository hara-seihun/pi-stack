import { expect, test } from "bun:test";
import { RouterSessions } from "./router-sessions";

test("revocation aborts in-flight work without affecting another person", () => {
  const sessions = new RouterSessions();
  const first = sessions.issue("owner");
  const second = sessions.issue("owner");
  const other = sessions.issue("other");
  const inflight = sessions.get(first)!;
  sessions.revoke("owner");
  expect(inflight.signal.aborted).toBe(true);
  expect(sessions.get(first)).toBeNull();
  expect(sessions.get(second)).toBeNull();
  expect(sessions.get(other)?.user).toBe("other");
  expect(sessions.get("invented")).toBeNull();
});

test("expired and excess sessions lose authority", () => {
  const expired = new RouterSessions(-1);
  expect(expired.get(expired.issue("owner"))).toBeNull();
  const sessions = new RouterSessions();
  const first = sessions.issue("owner");
  const inflight = sessions.get(first)!;
  for (let i = 0; i < 32; i++) sessions.issue("owner");
  expect(sessions.get(first)).toBeNull();
  expect(inflight.signal.aborted).toBe(true);
});
