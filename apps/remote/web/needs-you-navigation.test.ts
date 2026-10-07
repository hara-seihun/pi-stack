import { expect, test } from "bun:test";
import type { ThreadQuestion } from "../server/protocol";
import { formatRoute, parseRoute, routeThreadId, TABS } from "./src/app/routes";
import { prioritizeQuestion } from "./src/features/conversation/question-drafts";

test("Needs you has a main navigation route, not a notification filter", () => {
  expect(TABS).toContain("needs-you");
  expect(parseRoute(formatRoute({ tab: "needs-you" }))).toEqual({ tab: "needs-you" });
  expect(routeThreadId({ tab: "needs-you" })).toBeNull();
});

test("question links reach the existing owner and select the intended question without changing state", () => {
  const route = { tab: "chats" as const, chat: "ai:thread-a" as const, panel: null, questionId: "question:second" };
  expect(parseRoute(formatRoute(route))).toEqual(route);
  const questions: ThreadQuestion[] = ["first", "question:second", "third"].map(id => ({ id, threadId: "thread-a", question: id, suggestions: [], createdAt: 1 }));
  expect(prioritizeQuestion(questions, route.questionId).map(question => question.id)).toEqual(["question:second", "first", "third"]);
  expect(questions.map(question => question.id)).toEqual(["first", "question:second", "third"]);
  expect(prioritizeQuestion(questions, "answered")).toBe(questions);
  expect(() => parseRoute("#/calendar?question=q")).toThrow();
  expect(() => parseRoute("#/chats/human/contact?question=q")).toThrow();
});
