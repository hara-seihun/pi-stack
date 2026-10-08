import { expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { optimisticThreadSettings, SettingsFields } from "./src/thread-settings";
import type { Session, ThreadSettings } from "./src/types";

const settings: ThreadSettings = {
  models: [
    { provider: "anthropic", id: "claude-fable-5-1", thinkingLevels: ["low", "high"], speedModes: [] },
    { provider: "openai-codex", id: "gpt-6-astra", thinkingLevels: ["low", "high", "max"], speedModes: ["standard", "priority", "ultrafast"] },
    { provider: "openai-codex", id: "gpt-6.1-sol", thinkingLevels: ["low", "high", "max"], speedModes: ["standard", "priority", "ultrafast"] },
    { provider: "openai-codex", id: "gpt-6-luna", thinkingLevels: ["high", "max"], speedModes: ["standard", "priority"] },
  ],
  model: { provider: "openai-codex", id: "gpt-6-astra" }, thinkingLevels: ["high", "max"], thinkingLevel: "high",
  speedModes: ["standard", "priority", "ultrafast"], speedMode: "standard", bashTimeoutSeconds: 1800,
};
function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const fields = (session: Partial<Session>, saving = "", onUpdate = (_field: string, _body: Record<string, string | number>) => {}) =>
  elements(SettingsFields({ session: session as Session, settings, saving, onUpdate }));

test("running and held threads retain all settings controls", () => {
  for (const session of [{ state: "running", held: false }, { state: "idle", held: true }] as const) {
    const controls = fields({ ...session, queuedMessages: [{ state: "queued" }] as Session["queuedMessages"] }).filter(node => ["button", "select"].includes(String(node.type)));
    expect(controls.length).toBe(7);
    expect(controls.every(node => !node.props.disabled)).toBe(true);
  }
  expect(fields({}, "model").filter(node => ["button", "select"].includes(String(node.type))).every(node => node.props.disabled)).toBe(true);
  expect(fields({ archivedAt: "today" }).filter(node => ["button", "select"].includes(String(node.type))).every(node => node.props.disabled)).toBe(true);
});

test("future model selection preserves the effective model and explicitly retries dormant waiting work", () => {
  const waiting: ThreadSettings = { ...settings, effectiveModel: "anthropic-2/claude-opus-5-5", waiting: "provider", canRetryWaiting: true };
  const selected = optimisticThreadSettings(waiting, { modelProvider: "openai-codex", modelId: "gpt-6-astra" });
  expect(selected.effectiveModel).toBe(waiting.effectiveModel);
  const changes: unknown[] = [];
  const nodes = elements(SettingsFields({ session: {} as Session, settings: selected, saving: "", onUpdate: (field, body) => changes.push({ field, body }) }));
  const retry = nodes.find(node => node.type === "button" && node.props.children === "Switch waiting work to selected model")!;
  retry.props.onClick(); expect(changes).toEqual([{ field: "retry", body: { retryWaiting: 1 } }]);
  expect(elements(SettingsFields({ session: {} as Session, settings: { ...selected, waiting: null, canRetryWaiting: false }, saving: "", onUpdate: () => {} })).some(node => node.props.children === retry.props.children)).toBe(false);
});

test("optimistic model selection changes its dependent settings before the response", () => {
  const accelerated = { ...settings, speedMode: "ultrafast" };
  const fable = optimisticThreadSettings(accelerated, { modelProvider: "anthropic", modelId: "claude-fable-5-1" });
  expect(fable).toMatchObject({
    model: { provider: "anthropic", id: "claude-fable-5-1" },
    thinkingLevels: ["low", "high"],
    thinkingLevel: "high",
    speedModes: [],
    speedMode: "standard",
  });
  const luna = optimisticThreadSettings(accelerated, { modelProvider: "openai-codex", modelId: "gpt-6-luna" });
  expect(luna).toMatchObject({ thinkingLevels: ["high", "max"], thinkingLevel: "max", speedModes: ["standard", "priority"], speedMode: "standard" });
  const astra = optimisticThreadSettings(luna, { modelProvider: "openai-codex", modelId: "gpt-6-astra" });
  expect(astra).toMatchObject({ thinkingLevel: "high", speedModes: ["standard", "priority", "ultrafast"], speedMode: "standard" });
  expect(accelerated.speedMode).toBe("ultrafast");
  expect(optimisticThreadSettings(settings, { bashTimeoutSeconds: 60 }).bashTimeoutSeconds).toBe(60);
  expect(settings.bashTimeoutSeconds).toBe(1800);
});

test("optimistic speed choices follow model metadata instead of a client-side model policy", () => {
  const metadata: ThreadSettings = {
    ...settings,
    models: settings.models.map(model => model.id === "gpt-6-astra" ? { ...model, speedModes: ["standard"] } : model),
  };
  const next = optimisticThreadSettings(metadata, { modelProvider: "openai-codex", modelId: "gpt-6-astra" });
  expect(next.speedModes).toEqual(["standard"]);
  const missing = optimisticThreadSettings(metadata, { modelProvider: "openai-codex", modelId: "missing" });
  expect(missing.speedModes).toEqual([]);
});

test("speed controls reflect the selected model immediately after an optimistic switch", () => {
  for (const [provider, id, expected] of [
    ["openai-codex", "gpt-6-astra", ["Standard", "Priority", "Ultrafast"]],
    ["openai-codex", "gpt-6.1-sol", ["Standard", "Priority", "Ultrafast"]],
    ["openai-codex", "gpt-6-luna", ["Standard", "Priority"]],
    ["anthropic", "claude-fable-5-1", []],
  ] as const) {
    const selected = optimisticThreadSettings({ ...settings, speedMode: "ultrafast" }, { modelProvider: provider, modelId: id });
    const nodes = elements(SettingsFields({ session: {} as Session, settings: selected, saving: "", onUpdate: () => {} }));
    const speed = nodes.find(node => node.props["aria-label"] === "Speed mode");
    const choices = speed ? elements(speed.props.children).filter(node => node.props.role === "radio") : [];
    expect(choices.map(node => node.props.children)).toEqual([...expected]);
    expect(choices.filter(node => node.props["aria-checked"]).map(node => node.props.children)).toEqual(expected.length ? ["Standard"] : []);
  }
});

test("Sol's optimistic selection submits Ultrafast and retains it until a model change", () => {
  const sol = optimisticThreadSettings(settings, { modelProvider: "openai-codex", modelId: "gpt-6.1-sol" });
  const changes: unknown[] = [];
  const nodes = elements(SettingsFields({ session: {} as Session, settings: sol, saving: "", onUpdate: (field, body) => changes.push({ field, body }) }));
  nodes.find(node => node.props.role === "radio" && node.props.children === "Ultrafast")!.props.onClick();
  expect(changes).toEqual([{ field: "speed", body: { speedMode: "ultrafast" } }]);
  const selected = optimisticThreadSettings(sol, { speedMode: "ultrafast" });
  expect(selected.speedMode).toBe("ultrafast");
  const selectedNodes = elements(SettingsFields({ session: {} as Session, settings: selected, saving: "", onUpdate: () => {} }));
  expect(selectedNodes.find(node => node.props.role === "radio" && node.props.children === "Ultrafast")!.props["aria-checked"]).toBe(true);
  expect(optimisticThreadSettings(selected, { modelProvider: "openai-codex", modelId: "gpt-6-luna" }).speedMode).toBe("standard");
});

test("existing-thread model selector uses the new-chat groups without dropping custom choices", () => {
  const all: ThreadSettings = {
    ...settings,
    models: [...settings.models, { provider: "local", id: "bonsai-2-27b", name: "Bonsai", speedModes: [] }, { provider: "custom", id: "bespoke", name: "My model", speedModes: [] }],
  };
  const groups = elements(SettingsFields({ session: {} as Session, settings: all, saving: "", onUpdate: () => {} }))
    .filter(node => node.type === "optgroup");
  expect(groups.map(node => node.props.label)).toEqual(["God intelligence · Super expensive", "Smart models", "Cheap and fast", "Other models"]);
  expect(groups.map(node => elements(node.props.children).filter(child => child.type === "option").map(child => child.props.value))).toEqual([
    ["anthropic\0claude-fable-5-1", "openai-codex\0gpt-6-astra"],
    ["openai-codex\0gpt-6.1-sol"],
    ["openai-codex\0gpt-6-luna", "local\0bonsai-2-27b"],
    ["custom\0bespoke"],
  ]);
  expect(elements(groups[2]!.props.children).find(node => node.props.value === "openai-codex\0gpt-6-luna")?.props.children).toContain("🌙 ");
});

test("picker selects its saved model and submits the chosen model, thinking, speed and timeout", () => {
  const changes: unknown[] = [];
  const nodes = fields({}, "", (field, body) => changes.push({ field, body }));
  const model = nodes.find(node => node.props["aria-label"] === "Model")!;
  expect(elements(model.props.children).filter(node => node.type === "option" && node.props.value === model.props.value)).toHaveLength(1);
  model.props.onChange({ target: { value: "anthropic\0claude-fable-5-1" } });
  nodes.find(node => node.props.role === "radio" && node.props.children === "Max")!.props.onClick();
  nodes.find(node => node.props.role === "radio" && node.props.children === "Ultrafast")!.props.onClick();
  nodes.find(node => node.props["aria-label"] === "Bash timeout")!.props.onChange({ target: { value: "60" } });
  expect(changes).toEqual([
    { field: "model", body: { modelProvider: "anthropic", modelId: "claude-fable-5-1" } },
    { field: "thinking", body: { thinkingLevel: "max" } },
    { field: "speed", body: { speedMode: "ultrafast" } },
    { field: "bash-timeout", body: { bashTimeoutSeconds: 60 } },
  ]);
});

test("unset and unavailable models have explicit selected options instead of displaying the first catalog choice", () => {
  for (const model of [null, { provider: "custom", id: "missing" }]) {
    const nodes = elements(SettingsFields({ session: {} as Session, settings: { ...settings, model }, saving: "", onUpdate: () => {} }));
    const select = nodes.find(node => node.props["aria-label"] === "Model")!;
    const selected = elements(select.props.children).filter(node => node.type === "option" && node.props.value === select.props.value);
    expect(selected).toHaveLength(1);
    expect(selected[0].props.disabled).toBe(true);
    expect(select.props.value).toBe(model ? "custom\0missing" : "");
  }
});
