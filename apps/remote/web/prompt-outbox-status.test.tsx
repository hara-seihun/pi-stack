import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptOutboxStatus } from "./src/PromptOutboxStatus";
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
  expect(html).not.toContain("Retry same request");
});
