import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { copySavedPromptText, PromptOutboxStatus } from "./src/PromptOutboxStatus";
import type { PromptOutboxEntry, PromptOutboxOutcome } from "./src/prompt-outbox";

const entry = (outcome: PromptOutboxOutcome): PromptOutboxEntry => ({ requestId: "request", sessionId: "thread", createdAt: 1,
  bodyJson: JSON.stringify({ requestId: "request", text: "<unsafe>" + "long ".repeat(100), delivery: "hardSteer" }), outcome });
const render = (entries: PromptOutboxEntry[], busyRequestId: string | null = null) => renderToStaticMarkup(
  <PromptOutboxStatus entries={entries} busyRequestId={busyRequestId} onRetry={() => {}} onDiscard={() => {}} />,
);

test("accepted admissions and healthy initial submission have no recovery card", () => {
  expect(render([entry({ kind: "accepted", workId: "admission-only-not-execution" })])).toBe("");
  expect(render([entry({ kind: "pending", reason: "saved", message: "Saved" })], "request")).toBe("");
});

test("unconfirmed prompts expose same-identity retry and explicit non-cancellation dismissal", () => {
  const html = render([entry({ kind: "pending", reason: "transport", message: "Acknowledgement lost" })]);
  expect(html).toContain("Retry same request");
  expect(html).toContain("does not cancel a prompt the server already accepted");
  expect(html).toContain("hardSteer");
  expect(html).toContain("&lt;unsafe&gt;");
  expect(html).not.toContain("<unsafe>");
  expect(html).not.toContain("long ".repeat(40));
  expect(render([entry({ kind: "pending", reason: "transport", message: "Acknowledgement lost" })], "request")).toContain("disabled");
});

test("definitive rejection is retained and dismissible, but cannot pretend replay might accept it", () => {
  const html = render([entry({ kind: "rejected", message: "Reply target missing" })]);
  expect(html).toContain("Prompt rejected");
  expect(html).toContain("Reply target missing");
  expect(html).toContain("Dismiss saved prompt");
  expect(html).toContain("Copy saved text");
  expect(html).toContain("Full saved text");
  expect(html).not.toContain("Retry same request");
});

test("copy preserves the full exact saved text and returns visible clipboard failures", async () => {
  const text = "  exact saved text\\n".repeat(100);
  let copied: string | null = null;
  expect(await copySavedPromptText(text, { writeText: async value => { copied = value; } })).toEqual({ ok: true });
  expect(copied).toBe(text);
  expect(await copySavedPromptText(text, undefined)).toMatchObject({ ok: false, error: expect.stringContaining("Full saved text") });
  expect(await copySavedPromptText(text, { writeText: async () => { throw new Error("Permission denied"); } })).toEqual({ ok: false, error: "Could not copy saved text: Permission denied" });
});
