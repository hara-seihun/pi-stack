import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { correctedWords, parseDictionary, WriteDictionary } from "./write";

test("learns plausible word corrections, not deletions or unrelated rewrites", () => {
  expect(correctedWords("hello Keelana today", "hello Kelana today")).toEqual([{ from: "Keelana", to: "Kelana" }]);
  expect(correctedWords("hello Keelana today", "hello today")).toEqual([]);
  expect(correctedWords("hello world", "hello mountain")).toEqual([]);
});

test("person dictionary stores corrections and undoes only the receipt", () => {
  const db = new Database(":memory:");
  const dictionary = new WriteDictionary(db);
  const first = dictionary.learn("Keelana", "Kelana");
  expect(first.words).toEqual(["Kelana"]);
  expect(first.replacements).toEqual([]);
  const second = dictionary.learn("Keelana", "Kelana");
  expect(second.replacements).toEqual([{ from: "Keelana", to: "Kelana" }]);
  dictionary.put({ words: [...dictionary.get().words, "Fable"], replacements: dictionary.get().replacements });
  expect(dictionary.undo(second.undoId!)).toEqual({ words: ["Kelana", "Fable"], replacements: [] });
  expect(dictionary.undo(second.undoId!)).toBeNull();
  expect(dictionary.undo(first.undoId!)).toEqual({ words: ["Fable"], replacements: [] });
  db.close();
});

test("rejects duplicate words and malformed replacement rules", () => {
  expect(parseDictionary({ words: ["Kelana", "kelana"], replacements: [] })).toBeNull();
  expect(parseDictionary({ words: [], replacements: [{ from: "", to: "Kelana" }] })).toBeNull();
});
