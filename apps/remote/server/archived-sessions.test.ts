import { expect, test } from "bun:test";
import { archivedSessions } from "./archived-sessions";

function row(id: string, updatedAt: number, overrides = {}) {
  return { id, name: id, updatedAt, parentId: null, archived_at: "2026-09-01T00:00:00.000Z", ...overrides };
}
const isPerson = (id: string) => !id.startsWith("fleet");

test("search filters all archived roots before limiting and counts only matches", () => {
  const rows = [
    ...Array.from({ length: 150 }, (_, index) => row(`unrelated-${index}`, 1_000 + index)),
    row("match-older", 10, { name: "Design REVIEW" }),
    row("match-newer", 20, { name: "Review notes" }),
    row("active", 100, { name: "Review", archived_at: null }),
    row("child", 100, { name: "Review", parentId: "match-newer" }),
    row("fleet-root", 100, { name: "Review" }),
  ];
  const params = new URLSearchParams("query=+rEvIeW+&conversationsOnly=true&limit=1");
  const first = archivedSessions(rows, params, isPerson);
  expect(first).toMatchObject({ total: 2, offset: 0, limit: 1, hasMore: true });
  expect(first.sessions.map(session => session.id)).toEqual(["match-newer"]);
  params.set("offset", "1");
  const second = archivedSessions(rows, params, isPerson);
  expect(second).toMatchObject({ total: 2, offset: 1, limit: 1, hasMore: false });
  expect(second.sessions.map(session => session.id)).toEqual(["match-older"]);
  params.set("offset", "2");
  expect(archivedSessions(rows, params, isPerson)).toMatchObject({ sessions: [], total: 2, hasMore: false });
});

test("conversation listing uses recent activity while absent options retain archive-date order and all origins", () => {
  const rows = [
    row("older-activity", 10, { archived_at: "2026-09-20T00:00:00.000Z" }),
    row("recent-activity", 20),
    row("fleet-root", 30),
    row("child", 40, { parentId: "recent-activity" }),
  ];
  expect(archivedSessions(rows, new URLSearchParams(), isPerson)).toEqual({
    sessions: rows, total: 4, offset: 0, limit: 50, hasMore: false,
  });
  for (const query of ["conversationsOnly=true", "query=&conversationsOnly=true"]) {
    expect(archivedSessions(rows, new URLSearchParams(query), isPerson).sessions.map(session => session.id))
      .toEqual(["recent-activity", "older-activity"]);
  }
  expect(archivedSessions(rows, new URLSearchParams("query=child"), isPerson).total).toBe(1);
});

test("title searches treat punctuation literally and return an empty matching total", () => {
  const rows = [row("100%_done", 10), row("100-percent-done", 20)];
  expect(archivedSessions(rows, new URLSearchParams({ query: "%_" }), isPerson).sessions).toEqual([rows[0]!]);
  expect(archivedSessions(rows, new URLSearchParams("query=absent"), isPerson)).toMatchObject({ sessions: [], total: 0, hasMore: false });
});

test("pagination keeps its default and clamping behavior", () => {
  const rows = Array.from({ length: 151 }, (_, index) => row(String(index), index));
  for (const [query, offset, limit] of [
    ["limit=500&offset=-1", 0, 100],
    ["limit=0&offset=nonsense", 0, 50],
    ["limit=-5&offset=2.9", 2, 1],
    ["limit=20&offset=20", 20, 20],
  ] as const) {
    const page = archivedSessions(rows, new URLSearchParams(query), isPerson);
    expect(page).toMatchObject({ offset, limit, total: 151, hasMore: true });
    expect(page.sessions).toHaveLength(limit);
  }
});
