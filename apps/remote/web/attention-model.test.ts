import { expect, test } from "bun:test";
import { attentionFeed } from "./src/attention-model";
import type { NeedsYouItem } from "../shared/needs-you";
import type { CalendarEvent } from "../server/calendar-protocol";
import type { HistoryNotification } from "../server/protocol";

const now = Date.parse("2026-10-08T12:00:00Z");
function need(id: string, deadline: string | null, location: NeedsYouItem["location"] = null): NeedsYouItem {
  return { id, title: id, kind: "decision", deadline: deadline === null ? null : { at: deadline, timeZone: "UTC" }, location, consequence: null, recommendation: null, nextAction: null, commitmentId: null };
}
function event(id: string, start: string, allDay = false): CalendarEvent {
  return { id, title: id, start, end: allDay ? "2026-10-09" : "2026-10-08T18:00:00Z", zone: "UTC", allDay, notes: "", location: "", updated: "2026-10-01T00:00:00Z" };
}
function notice(seq: number, status: HistoryNotification["status"] = "needs-you"): HistoryNotification {
  const base = { seq, sessionId: "thread-a", name: "Source", time: "2026-10-08T10:00:00Z", kind: "attention" as const };
  return status === "unavailable" ? { ...base, status, error: "Owner offline" } : { ...base, status };
}

test("decisions and appointments share deadline order; undated needs and unread updates stay actionable", () => {
  const feed = attentionFeed([need("later", "2026-10-08T17:00:00Z"), need("undated", null), need("due", "2026-10-08T11:00:00Z")], [notice(1), notice(2, "history")], [event("appointment", "2026-10-08T16:00:00Z")], "UTC", now);
  expect(feed.now.map(item => item.id)).toEqual(["need:undated", "notice:1", "need:due"]);
  expect(feed.upcoming.map(item => item.id)).toEqual(["event:appointment", "need:later"]);
  expect(feed.history.map(item => item.id)).toEqual(["notice:2"]);
});

test("a linked question is shown once but unrelated questions and updates in its conversation survive", () => {
  const linked = { ...notice(1), kind: "question" as const, questionId: "q" };
  const otherOwner = { ...linked, seq: 2, sessionId: "thread-b" };
  const otherQuestion = { ...linked, seq: 3, questionId: "other" };
  const feed = attentionFeed([need("linked-decision", null, { threadId: "thread-a", questionId: "q" })], [linked, otherOwner, otherQuestion, notice(4)], [], "UTC", now);
  expect(feed.now.map(item => item.id)).toEqual(["need:linked-decision", "notice:2", "notice:3", "notice:4"]);
});

test("pagination overlap is deduplicated and unavailable status is not converted into resolved history", () => {
  const feed = attentionFeed([], [notice(1), notice(1), notice(2, "unavailable"), notice(3, "history"), notice(3, "history")], [], "UTC", now);
  expect(feed.now.map(item => item.id)).toEqual(["notice:1", "notice:2"]);
  expect(feed.history.map(item => item.id)).toEqual(["notice:3"]);
});

test("past calendar selections stay editable in history rather than becoming current tasks", () => {
  const past = { ...event("past", "2026-10-07T10:00:00Z"), end: "2026-10-07T11:00:00Z" };
  const ongoing = event("ongoing", "2026-10-08T11:30:00Z");
  const feed = attentionFeed([], [], [past, ongoing], "UTC", now);
  expect(feed.now.map(item => item.id)).toEqual(["event:ongoing"]);
  expect(feed.history.map(item => item.id)).toEqual(["event:past"]);
});

test("all-day appointments use display-zone midnight rather than UTC to decide when they need attention", () => {
  const localNow = Date.parse("2026-10-08T02:00:00Z");
  const feed = attentionFeed([], [], [event("day", "2026-10-08", true)], "America/Los_Angeles", localNow);
  expect(feed.now).toEqual([]);
  expect(feed.upcoming[0].at).toBe(Date.parse("2026-10-08T07:00:00Z"));
});
