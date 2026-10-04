import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelAvailabilityControls, setModelAvailability } from "./src/features/machine/Models";

const models = [
  { id: "openai/gpt-astra", label: "Astra", icon: "openai", enabled: false },
  { id: "anthropic/claude-opus", label: "Opus", icon: "anthropic", enabled: true },
];

test("availability sends an idempotent desired state and encoded provider/model identity", async () => {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  try {
    globalThis.window = { PiRemotePerson: { session: () => "test-session" } } as any;
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), method: init!.method!, body: JSON.parse(String(init!.body)) });
      return Response.json({ models });
    }) as typeof fetch;
    expect(await setModelAvailability(models[0]!.id, true)).toEqual({ ok: true, value: { models } });
    expect(await setModelAvailability(models[0]!.id, true)).toEqual({ ok: true, value: { models } });
    expect(requests).toEqual([
      { url: "/v1/models/openai%2Fgpt-astra/availability", method: "PUT", body: { enabled: true } },
      { url: "/v1/models/openai%2Fgpt-astra/availability", method: "PUT", body: { enabled: true } },
    ]);
    globalThis.fetch = (async () => Response.json({ error: "Could not save model policy" }, { status: 500 })) as typeof fetch;
    expect(await setModelAvailability(models[1]!.id, false)).toEqual({ ok: false, error: "Could not save model policy" });
  } finally {
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
});

test("switches retain authoritative states during saves and failed updates", () => {
  const html = renderToStaticMarkup(createElement(ModelAvailabilityControls, {
    models,
    changes: {
      [models[0]!.id]: { pending: true, error: "" },
      [models[1]!.id]: { pending: false, error: "Could not save model policy" },
    },
    onSet() {},
  }));
  expect(html).toContain('role="switch" aria-label="Astra for new threads" aria-checked="false" aria-busy="true" disabled=""');
  expect(html).toContain('role="switch" aria-label="Opus for new threads" aria-checked="true"');
  expect(html).toContain("Disabled · Saving…");
  expect(html).toContain('role="alert">Could not save model policy');
  expect(html).toContain('aria-label="Dismiss Opus availability error"');
});
