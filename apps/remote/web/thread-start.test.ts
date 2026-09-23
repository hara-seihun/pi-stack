import { expect, test } from "bun:test";
import { threadStartReducer as reduce, threadStartSelection, type ThreadStartEvent, type ThreadStartState } from "./src/thread-start-state";
import type { ThreadStart } from "./src/types";

const starts: ThreadStart[] = [
  { id: "home", label: "Home", icon: "home", models: [{ id: "astra", label: "Astra", icon: "openai" }] },
  { id: "work", label: "Work", icon: "work", models: [] },
];
const open = (): ThreadStartState => reduce({ kind: "closed" }, { type: "open", starts });
const choose = (id: string, stage = "destinations"): ThreadStartEvent => ({ type: "choose", id, stage, origin: -54, requestId: "request-1", sessionId: "thread-1" });

test("an open gesture owns its options until dismissed, then opening captures the latest catalogue", () => {
  const destinations = open();
  const models = reduce(destinations, choose("home"));
  const refreshed = structuredClone(starts).reverse();
  refreshed[1].models = [];
  for (const state of [destinations, models]) {
    expect(reduce(state, { type: "open", starts: refreshed })).toBe(state);
    expect(threadStartSelection(state)?.starts).toBe(starts);
  }
  expect(models.kind).toBe("models");
  expect(reduce(reduce(models, { type: "dismiss" }), { type: "open", starts: refreshed })).toEqual({ kind: "destinations", starts: refreshed });
});

test("exiting destination buttons cannot create a thread from the model stage", () => {
  const models = reduce(open(), choose("home"));
  expect(reduce(models, choose("work"))).toBe(models);
  expect(reduce(models, choose("missing", "models:home"))).toBe(models);
  const creating = reduce(models, choose("astra", "models:home"));
  expect(creating).toMatchObject({ kind: "creating", request: { destination: "home", model: "astra" } });
  expect(reduce(creating, choose("astra", "models:home"))).toBe(creating);
});

test("single-model destinations create directly and retries retain both idempotency IDs", () => {
  const creating = reduce(open(), choose("work"));
  expect(creating).toMatchObject({ kind: "creating", request: { destination: "work", model: null } });
  const failed = reduce(creating, { type: "failed", requestId: "request-1", error: "Connection lost" });
  expect(failed.kind).toBe("failed");
  expect(reduce(failed, choose("work"))).toBe(failed);
  expect(reduce(failed, { type: "retry" })).toEqual(creating);
  expect(reduce(creating, { type: "created", requestId: "request-1" })).toEqual({ kind: "closed" });
});

test("late success or failure cannot dismiss a newer gesture or request", () => {
  const creating = reduce(open(), choose("work"));
  const reopened = reduce(reduce(creating, { type: "dismiss" }), { type: "open", starts });
  const next = reduce(reopened, { ...choose("work"), requestId: "request-2", sessionId: "thread-2" } as ThreadStartEvent);
  for (const state of [reopened, next]) {
    expect(reduce(state, { type: "created", requestId: "request-1" })).toBe(state);
    expect(reduce(state, { type: "failed", requestId: "request-1", error: "Too late" })).toBe(state);
  }
});

test("an unavailable catalogue does not open an empty picker", () => {
  expect(reduce({ kind: "closed" }, { type: "open", starts: [] })).toEqual({ kind: "closed" });
});

test("checked context files travel with the creation request and only for destinations that offer them", () => {
  const personal: ThreadStart = {
    id: "personal", label: "Personal", icon: "personal",
    models: [{ id: "astra", label: "Astra", icon: "openai" }],
    contexts: [{ name: "HARA.md", tokens: 99_207, bytes: 409_078 }, { name: "NEBULANI.md", tokens: 39_282, bytes: 167_920 }],
  };
  const opened = reduce({ kind: "closed" }, { type: "open", starts: [personal, ...starts] });
  const models = reduce(opened, choose("personal"));
  expect(models).toMatchObject({ kind: "models", contexts: [] });
  const one = reduce(models, { type: "toggleContext", name: "NEBULANI.md" });
  expect(one).toMatchObject({ contexts: ["NEBULANI.md"] });
  const both = reduce(one, { type: "toggleContext", name: "HARA.md" });
  expect(both).toMatchObject({ contexts: ["HARA.md", "NEBULANI.md"] });
  expect(reduce(both, { type: "toggleContext", name: "missing.md" })).toBe(both);
  expect(reduce(reduce(both, { type: "toggleContext", name: "HARA.md" }), choose("astra", "models:personal")))
    .toMatchObject({ kind: "creating", request: { destination: "personal", model: "astra", contextFiles: ["NEBULANI.md"] } });
  const plain = reduce(reduce(open(), choose("home")), { type: "toggleContext", name: "HARA.md" });
  expect(plain).toMatchObject({ kind: "models", contexts: [] });
  expect(reduce(plain, choose("astra", "models:home"))).toMatchObject({ kind: "creating", request: { destination: "home", model: "astra" } });
  expect((reduce(plain, choose("astra", "models:home")) as { request: { contextFiles?: string[] } }).request.contextFiles).toBeUndefined();
});
