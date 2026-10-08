import { expect, test } from "bun:test";
import type { ThreadQuestion } from "../server/protocol";
import { formatRoute, parseRoute, routeThreadId, TABS } from "./src/app/routes";
import { prioritizeQuestion } from "./src/features/conversation/question-drafts";

test("one Attention destination replaces the three entrances and retains existing links", () => {
  expect(TABS).toEqual(["chats", "attention", "agents", "files", "machine"]);
  expect(parseRoute(formatRoute({ tab: "attention" }))).toEqual({ tab: "attention" });
  expect(routeThreadId({ tab: "attention" })).toBeNull();
  for (const hash of ["#/needs-you", "#/notifications", "#/calendar"]) expect(parseRoute(hash)).toEqual({ tab: "attention" });
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
