import { expect, it } from "vitest";
import { settledWorkOutcome } from "../src/threads/service.js";

it.each([
  ["stop", "complete"], ["length", "complete"], ["toolUse", "complete"], ["error", "failed"], ["aborted", "cancelled"],
])("maps the explicit assistant terminal reason %s", (stopReason, outcome) => {
  expect(settledWorkOutcome(undefined, { stopReason })).toBe(outcome);
});
it.each(["complete", "failed", "cancelled"])("retains native terminal outcome %s", outcome => {
  expect(settledWorkOutcome(outcome, null)).toBe(outcome);
});
it("never turns an unknown terminal outcome or stop reason into success", () => {
  expect(() => settledWorkOutcome("unrecognized", null)).toThrow("Unknown work outcome");
  expect(() => settledWorkOutcome(undefined, { stopReason: "unrecognized" })).toThrow();
  expect(() => settledWorkOutcome(undefined, {})).toThrow();
  expect(() => settledWorkOutcome(undefined, { stopReason: "pending" })).toThrow("nonterminal");
  expect(() => settledWorkOutcome(undefined, { stopReason: "deferred" })).toThrow("nonterminal");
});
it("allows an explicitly completed native turn with no assistant output", () => {
  expect(settledWorkOutcome(undefined, null)).toBe("complete");
});
