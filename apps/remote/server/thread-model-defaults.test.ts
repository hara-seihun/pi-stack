import { expect, test } from "bun:test";
import { catalogModel } from "pi-orchestrator/api";
import { defaultThreadDestinations } from "./thread-model-defaults";

test("built-in and newly registered destinations default to Astra and expose each OpenAI model", () => {
  const home = defaultThreadDestinations();
  const personal = defaultThreadDestinations("private-workspace");
  expect(home.map(destination => destination.id)).toEqual(["home"]);
  expect(personal.map(destination => destination.workspaceId)).toEqual(["private-workspace", "home"]);
  expect(personal[1]).toEqual(home[0]);
  for (const destination of [...home, ...personal]) {
    expect(destination.defaultModel).toBe("astra");
    expect(destination.thinkingLevel).toBe("high");
    expect(destination.models.slice(0, 4)).toEqual(["astra", "sol", "terra", "luna"]);
    expect(destination.models).toContain(destination.defaultModel);
    expect(new Set(destination.models).size).toBe(destination.models.length);
    for (const id of destination.models) expect(catalogModel(id)).toBeDefined();
  }
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
