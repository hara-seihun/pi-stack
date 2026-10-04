import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Models, ModelAvailabilityControls, setModelAvailability } from "./src/features/machine/Models";

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

test("administrator switches retain authoritative states during saves and failed updates", () => {
  const html = renderToStaticMarkup(createElement(ModelAvailabilityControls, {
    models,
    canManage: true,
    changes: {
      [models[0]!.id]: { pending: true, error: "" },
      [models[1]!.id]: { pending: false, error: "Could not save model policy" },
    },
    onSet() {},
  }));
  expect(html).toContain('role="switch" aria-label="Astra for everyone&#x27;s new threads" aria-checked="false" aria-busy="true" disabled=""');
  const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
  expect(switches).toHaveLength(2);
  expect(switches[1]).toContain('aria-checked="true"');
  expect(switches[1]).not.toContain('disabled=""');
  expect(html).toContain("Disabled · Saving…");
  expect(html).toContain('role="alert">Could not save model policy');
  expect(html).toContain('aria-label="Dismiss Opus availability error"');
});

test("nonadministrators and missing capabilities show global states read-only", () => {
  for (const canManage of [false, undefined]) {
    const html = renderToStaticMarkup(createElement(Models, { models, canManage }));
    const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
    expect(switches).toHaveLength(2);
    expect(switches[0]).toContain('aria-checked="false"');
    expect(switches[1]).toContain('aria-checked="true"');
    for (const control of switches) expect(control).toContain('disabled=""');
  }
});

test("only administrator controls dispatch desired state changes", () => {
  for (const canManage of [true, false, undefined]) {
    const changes: Array<[string, boolean]> = [];
    const view = ModelAvailabilityControls({
      models,
      canManage,
      changes: {},
      onSet: (id, enabled) => changes.push([id, enabled]),
    });
    for (const row of view.props.children[2].props.children) {
      row.props.children[0].props.onClick();
    }
    expect(changes).toEqual(canManage ? [[models[0]!.id, true], [models[1]!.id, false]] : []);
  }
});
