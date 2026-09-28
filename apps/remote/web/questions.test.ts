import { expect, test } from "bun:test";
import { answerIsValid, emptyQuestionDraft, QuestionDrafts, toggleSuggestion } from "./src/features/conversation/question-drafts";

Object.assign(globalThis, { location: { href: "http://localhost/remote/" } });

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("any number of suggestions may be checked or unchecked, independent of free text", () => {
  const blank = emptyQuestionDraft();
  expect(answerIsValid(blank)).toBe(false);
  expect(answerIsValid({ ...blank, text: " \n " })).toBe(false);
  expect(answerIsValid({ ...blank, text: "Another answer" })).toBe(true);
  const first = toggleSuggestion(blank, "one");
  const both = toggleSuggestion(first, "two");
  expect(both.selectedSuggestionIds).toEqual(["one", "two"]);
  expect(answerIsValid(both)).toBe(true);
  expect(toggleSuggestion(both, "one").selectedSuggestionIds).toEqual(["two"]);
  expect(toggleSuggestion(first, "one")).toEqual(blank);
  expect(answerIsValid({ selectedSuggestionIds: [], text: "Only my own answer" })).toBe(true);
});

test("drafts survive closing and switching threads; clearing an accepted answer cannot erase other drafts", () => {
  const store = storage();
  const drafts = new QuestionDrafts(store, "person-a");
  const first = { selectedSuggestionIds: ["one", "three"], text: "Details" };
  drafts.save("thread-a", "question-1", first);
  drafts.save("thread-b", "question-1", { selectedSuggestionIds: [], text: "Other thread" });
  drafts.save("thread-a", "question-2", { selectedSuggestionIds: ["two"], text: "" });
  expect(new QuestionDrafts(store, "person-a").load("thread-a", "question-1")).toEqual(first);
  drafts.clear("thread-a", "question-1");
  expect(drafts.load("thread-a", "question-1")).toEqual(emptyQuestionDraft());
  expect(drafts.load("thread-b", "question-1").text).toBe("Other thread");
  expect(drafts.load("thread-a", "question-2").selectedSuggestionIds).toEqual(["two"]);
  expect(new QuestionDrafts(store, "person-b").load("thread-b", "question-1")).toEqual(emptyQuestionDraft());
});

test("failed submission leaves the draft intact", () => {
  const drafts = new QuestionDrafts(storage(), "person");
  drafts.save("thread", "question", { selectedSuggestionIds: ["choice"], text: "Keep this" });
  expect(drafts.load("thread", "question")).toEqual({ selectedSuggestionIds: ["choice"], text: "Keep this" });
});
