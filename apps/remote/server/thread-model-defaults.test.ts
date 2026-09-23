import { expect, test } from "bun:test";
import { catalogModel } from "pi-orchestrator/api";
import { configuredThreadDestinations, defaultThreadDestinations, recentThreadModels, threadModelOptions } from "./thread-model-defaults";
import type { ThreadModelMetadata } from "pi-orchestrator/api";

test("built-in and newly registered destinations default to Astra and expose each OpenAI model", () => {
  const home = defaultThreadDestinations();
  const personal = defaultThreadDestinations("private-workspace");
  expect(home.map(destination => destination.id)).toEqual(["home", "raw"]);
  expect(personal.map(destination => destination.workspaceId)).toEqual(["private-workspace", "home", "home"]);
  expect(personal.slice(1)).toEqual(home);
  expect(home.map(destination => destination.raw)).toEqual([undefined, true]);
  for (const destination of [...home, ...personal]) {
    expect(destination.defaultModel).toBe("astra");
    expect(destination.thinkingLevel).toBe("high");
    expect(destination.models.slice(0, 3)).toEqual(["astra", "sol", "luna"]);
    expect(destination.models).toContain(destination.defaultModel);
    expect(new Set(destination.models).size).toBe(destination.models.length);
    for (const id of destination.models) expect(catalogModel(id)).toBeDefined();
  }
});

test("configured models join existing destinations and provider defaults follow configuration order", () => {
  const models = [{ provider: "custom", id: "z/default", name: "Default custom", icon: "🧪" }, { provider: "custom", id: "a-second", name: "Second", icon: "🔬" }] as ThreadModelMetadata[];
  const defaults = defaultThreadDestinations();
  const options = threadModelOptions(models);
  expect(options.get("custom")?.id).toBe("custom/z/default");
  expect(options.get("custom/z/default")?.icon).toBe("🧪");
  expect(() => threadModelOptions([{ provider: "custom", id: "plain", name: "No icon" } as ThreadModelMetadata])).toThrow("has no icon");
  const [home] = configuredThreadDestinations(defaults, models);
  expect(home!.defaultModel).toBe("astra");
  expect(home!.models.slice(-2)).toEqual(["custom/z/default", "custom/a-second"]);
  expect(defaults[0]!.models).not.toContain("custom/z/default");
  const [work] = configuredThreadDestinations([{ ...defaults[0]!, id: "work", models: ["custom"], defaultModel: "custom" }], models);
  expect(work!.defaultModel).toBe("custom/z/default");
  expect(work!.models).toEqual([...defaults[0]!.models, "custom/z/default", "custom/a-second"]);
  expect(configuredThreadDestinations(defaults, [])).toEqual(defaults);
  expect(() => configuredThreadDestinations([{ ...defaults[0]!, defaultModel: "missing" }], models)).toThrow("Unknown thread model");
});

test("empty and restricted person lists receive the shared models without changing their defaults", () => {
  const work = { ...defaultThreadDestinations()[0]!, id: "work", workspaceId: "work", models: [] };
  const configured = [
    { provider: "anthropic", id: "claude-fable-5-1", name: "Fable" },
    { provider: "abliteration", id: "abliterated-model-large-v2", name: "Abliteration", icon: "🧪" },
  ] as ThreadModelMetadata[];
  const shared = defaultThreadDestinations()[0]!.models;
  expect(configuredThreadDestinations([work], [])[0]).toEqual({ ...work, models: shared });
  const [resolved] = configuredThreadDestinations([work], configured);
  expect(resolved).toEqual({ ...work, models: [...shared, "abliteration/abliterated-model-large-v2"] });
  expect(resolved!.models).toContain(resolved!.defaultModel);
  expect(work.models).toEqual([]);
  const [custom] = configuredThreadDestinations([{ ...work, defaultModel: "abliteration" }], configured);
  expect(custom!.defaultModel).toBe("abliteration/abliterated-model-large-v2");
  expect(custom!.models).toEqual([...shared, "abliteration/abliterated-model-large-v2"]);
  const restricted = configuredThreadDestinations([{ ...work, models: ["fable"], defaultModel: "sol" }], configured)[0]!;
  expect(restricted.models).toEqual(resolved!.models);
  expect(restricted.defaultModel).toBe("sol");
});

test("recent model order includes archived use, resolves model IDs and separates destinations", () => {
  const configured = [{ provider: "anthropic", id: "claude-fable-5-1", name: "Fable" }] as ThreadModelMetadata[];
  const options = threadModelOptions(configured);
  const home = defaultThreadDestinations()[0]!;
  const history = [
    { profileId: "home", model: "luna", updatedAt: 100, archived: false },
    { profileId: "home", model: "anthropic/claude-fable-5-1", updatedAt: 200, archived: true },
    { profileId: "home", model: "fable", updatedAt: 50, archived: false },
    { profileId: "personal", model: "sol", updatedAt: 300, archived: false },
  ];
  expect(recentThreadModels(home, history, options)).toEqual(["fable", "luna", "astra", "sol", "opus"]);
  expect(recentThreadModels({ ...home, id: "personal" }, history, options)).toEqual(["sol", "astra", "luna", "fable", "opus"]);
  expect(home.models).toEqual(["astra", "sol", "luna", "fable", "opus"]);
});

test("unused and equally recent models retain configured order", () => {
  const home = defaultThreadDestinations()[0]!;
  const options = threadModelOptions([]);
  expect(recentThreadModels(home, [], options)).toEqual(home.models);
  expect(recentThreadModels(home, [
    { profileId: "home", model: "luna", updatedAt: 100 },
    { profileId: "home", model: "sol", updatedAt: 100 },
  ], options)).toEqual(["sol", "luna", "astra", "fable", "opus"]);
});

test("destination edits cannot change defaults for another person or workspace", () => {
  const destinations = defaultThreadDestinations("private");
  destinations[0]!.models.splice(0);
  destinations[0]!.defaultModel = "sol";
  expect(destinations[1]!.models).toContain("astra");
  expect(destinations[1]!.defaultModel).toBe("astra");
  expect(defaultThreadDestinations("another")[0]!.models).toContain("astra");
  expect(defaultThreadDestinations("another")[0]!.defaultModel).toBe("astra");
});
