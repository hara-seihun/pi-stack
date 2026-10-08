import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NeedsYouDismissal, NeedsYouItem } from "../shared/needs-you";
import { dismissNeed, NeedsYouCard } from "./src/needs-you";

const item: NeedsYouItem = {
  id: "question:thread-a:q-a", kind: "question", title: "Choose a time", consequence: null,
  deadline: null, recommendation: null, nextAction: null, commitmentId: null,
  location: { threadId: "thread-a", questionId: "q-a" },
  dismissal: { kind: "question", threadId: "thread-a", questionId: "q-a" },
};

test("dismissal posts only the owner's mutation target and preserves reported partial effects on HTTP errors", async () => {
  const fetchBefore = globalThis.fetch, windowBefore = globalThis.window;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  try {
    globalThis.window = { PiRemotePerson: { session: () => "test-session" } } as any;
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), method: init!.method!, body: JSON.parse(String(init!.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const targets: NeedsYouDismissal[] = [item.dismissal, { kind: "life", id: "decision-a", revision: 4 }, { kind: "commitment", id: "commitment-a", revision: 2 }];
    for (const target of targets) expect(await dismissNeed(target)).toEqual({ ok: true });
    expect(requests).toEqual(targets.map(body => ({ url: "/v1/needs-you/dismiss", method: "POST", body })));
    const partial = { ok: false as const, error: "revision_conflict", message: "Question dismissed; the life record changed. Refresh and try again.", questionDismissed: true };
    globalThis.fetch = (async () => Response.json(partial, { status: 409 })) as typeof fetch;
    expect(await dismissNeed(item.dismissal)).toEqual({ ok: false, message: partial.message, questionDismissed: true });
    globalThis.fetch = (async () => { throw new Error("Connection lost"); }) as typeof fetch;
    expect(await dismissNeed(item.dismissal)).toEqual({ ok: false, message: expect.stringContaining("Dismissal was not confirmed") });
    globalThis.fetch = (async () => Response.json({ ok: true }, { status: 500 })) as typeof fetch;
    expect(await dismissNeed(item.dismissal)).toEqual({ ok: false, message: expect.stringContaining("invalid response") });
    globalThis.fetch = (async () => Response.json({ ok: false, error: "failed", message: "Failed", questionDismissed: "yes" })) as typeof fetch;
    expect(await dismissNeed(item.dismissal)).toEqual({ ok: false, message: expect.stringContaining("invalid response") });
  } finally {
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
});

test("busy dismissal keeps the source answer link and card visible, suppresses repeat clicks, and explains commitment reminders", () => {
  const calls: NeedsYouItem[] = [];
  const onDismiss = (value: NeedsYouItem) => { calls.push(value); };
  const ready = NeedsYouCard({ item, busy: false, onDismiss });
  const busy = NeedsYouCard({ item, busy: true, onDismiss });
  const readyButton = ready.props.children[3].props.children[1];
  const busyButton = busy.props.children[3].props.children[1];
  readyButton.props.onClick();
  busyButton.props.onClick();
  expect(calls).toEqual([item]);
  expect(busyButton.props.disabled).toBe(true);
  const html = renderToStaticMarkup(busy);
  expect(html).toContain("Choose a time");
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Answer in original conversation");
  expect(html).toContain("question=q-a");
  const commitment = renderToStaticMarkup(<NeedsYouCard item={{ ...item, kind: "commitment", dismissal: { kind: "commitment", id: "commitment-a", revision: 2 } }} busy={false} onDismiss={onDismiss} />);
  expect(commitment).toContain("Dismiss reminder");
  expect(commitment).toContain("does not cancel your commitment");
});
