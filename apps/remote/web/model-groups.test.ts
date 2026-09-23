import { expect, test } from "bun:test";
import { groupedModels, modelDisplayIcon } from "./src/model-groups";
import { modelGlyph } from "./src/features/status/model-glyph";

const models = [
  { id: "custom", label: "Private model" },
  { id: "sol", label: "Sol" },
  { id: "luna", label: "Luna" },
  { id: "fable", label: "Fable" },
  { id: "bonsai", label: "Bonsai" },
  { id: "opus", label: "Opus" },
  { id: "astra", label: "Astra" },
  { id: "terra", label: "Terra" },
];

test("the same groups preserve offered models and their relative recent-use order", () => {
  const groups = groupedModels(models, model => model);
  expect(groups.map(group => [group.title, group.description, group.models.map(model => model.id)])).toEqual([
    ["God intelligence", "Super expensive", ["fable", "astra"]],
    ["Smart models", "", ["sol", "opus"]],
    ["Cheap and fast", "", ["luna", "bonsai"]],
    ["Other models", "", ["custom", "terra"]],
  ]);
  expect(groupedModels([{ id: "gpt-6-luna", label: "GPT-6 Luna" }, { id: "claude-fable-5-1", label: "Claude Fable" }], model => model).map(group => group.id)).toEqual(["god", "fast"]);
  expect(groupedModels([{ id: "personal-thing", label: "Personal thing" }], model => model).map(group => group.id)).toEqual(["other"]);
});

test("Luna has a moon in the new chat picker and existing thread labels", () => {
  expect(modelDisplayIcon("luna", "Luna", "luna")).toBe("🌙");
  expect(modelGlyph("openai-codex/gpt-6-luna")).toMatchObject({ glyph: "🌙", emoji: true });
});
