import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { adoptRetainedResponseHeartbeats, parseResponseEvent } from "../src/response-events.js";

function retained() {
  const source = readFileSync(new URL("../src/response-events.ts", import.meta.url), "utf8");
  const literal = source.match(/const responseEvents = (\{[\s\S]*?\}) satisfies/)!;
  const registry = Function(`return (${literal[1]})`)() as Record<string, string>;
  delete registry.keepalive;
  const parse = Function("responseEvents", `return (${String(parseResponseEvent)});`)(registry) as typeof parseResponseEvent;
  return { registry, parse };
}

it("adopts exact retained captured parser registries and is idempotent without changing other metadata", () => {
  const first = retained(), second = retained();
  const original = Object.getOwnPropertyDescriptors(first.registry);
  expect(first.parse({ type: "keepalive" }).ok).toBe(false);
  expect(adoptRetainedResponseHeartbeats([first, second, first])).toMatchObject({ ok: true, value: { parsers: 3, registries: 2, changed: 2 } });
  expect(first.parse({ type: "keepalive" })).toMatchObject({ ok: true, value: { kind: "progress" } });
  expect(second.parse({ type: "response.new_variant" }).ok).toBe(false);
  for (const [key, descriptor] of Object.entries(original)) expect(Object.getOwnPropertyDescriptor(first.registry, key)).toEqual(descriptor);
  expect(adoptRetainedResponseHeartbeats([first, second])).toMatchObject({ ok: true, value: { changed: 0 } });
});

it.each(["unknown", "missing", "wrong-value", "descriptor", "frozen", "proxy", "parser"])("preflights the whole cohort before any mutation: %s", kind => {
  const first = retained(), second = retained();
  if (kind === "unknown") second.registry["response.new_variant"] = "progress";
  if (kind === "missing") delete second.registry["response.completed"];
  if (kind === "wrong-value") second.registry["response.completed"] = "progress";
  if (kind === "descriptor") Object.defineProperty(second.registry, "response.completed", { enumerable: false });
  if (kind === "frozen") Object.freeze(second.registry);
  if (kind === "proxy") second.registry = new Proxy(second.registry, {});
  if (kind === "parser") second.parse = (() => ({ ok: true, value: { kind: "progress", event: {} } })) as typeof parseResponseEvent;
  expect(adoptRetainedResponseHeartbeats([first, second]).ok).toBe(false);
  expect(Object.hasOwn(first.registry, "keepalive")).toBe(false);
  expect(first.parse({ type: "keepalive" }).ok).toBe(false);
});

it("restores all additions if a captured parser does not read its declared registry", () => {
  const first = retained(), second = retained(), unrelated = retained();
  second.parse = unrelated.parse;
  expect(adoptRetainedResponseHeartbeats([first, second])).toMatchObject({ ok: false, error: { code: "binding-conflict" } });
  expect(Object.hasOwn(first.registry, "keepalive")).toBe(false);
  expect(Object.hasOwn(second.registry, "keepalive")).toBe(false);
});

it("requires a nonempty explicit cohort and validates already-present heartbeat descriptors", () => {
  expect(adoptRetainedResponseHeartbeats([])).toMatchObject({ ok: false, error: { code: "invalid-cohort" } });
  const target = retained();
  target.registry.keepalive = "completed";
  expect(adoptRetainedResponseHeartbeats([target])).toMatchObject({ ok: false, error: { code: "registry-conflict" } });
});
