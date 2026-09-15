import { expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { SettingsFields } from "./src/thread-settings";
import type { Session, ThreadSettings } from "./src/types";

const settings: ThreadSettings = {
  children: [], models: [{ provider: "anthropic", id: "claude-fable-5-1" }, { provider: "openai-codex", id: "gpt-6-astra" }],
  model: { provider: "openai-codex", id: "gpt-6-astra" }, thinkingLevels: ["high", "max"], thinkingLevel: "high",
  speedModes: ["standard", "priority"], speedMode: "standard", bashTimeoutSeconds: 1800,
};
function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const fields = (session: Partial<Session>, saving = "", onUpdate = (_field: string, _body: Record<string, string | number>) => {}) =>
  elements(SettingsFields({ session: session as Session, settings, saving, onUpdate }));

test("running and stopped threads with held messages retain all settings controls", () => {
  for (const state of ["running", "stopped"] as const) {
    const controls = fields({ state, queuedMessages: [{ state: "held" }] as Session["queuedMessages"] }).filter(node => ["button", "select"].includes(String(node.type)));
    expect(controls.length).toBe(6);
    expect(controls.every(node => !node.props.disabled)).toBe(true);
  }
  expect(fields({}, "model").filter(node => ["button", "select"].includes(String(node.type))).every(node => node.props.disabled)).toBe(true);
  expect(fields({ archivedAt: "today" }).filter(node => ["button", "select"].includes(String(node.type))).every(node => node.props.disabled)).toBe(true);
});

test("picker selects its saved model and submits the chosen model, thinking, speed and timeout", () => {
  const changes: unknown[] = [];
  const nodes = fields({}, "", (field, body) => changes.push({ field, body }));
  const model = nodes.find(node => node.props["aria-label"] === "Model")!;
  expect(elements(model.props.children).filter(node => node.type === "option" && node.props.value === model.props.value)).toHaveLength(1);
  model.props.onChange({ target: { value: "anthropic\0claude-fable-5-1" } });
  nodes.find(node => node.props.role === "radio" && node.props.children === "Max")!.props.onClick();
  nodes.find(node => node.props.role === "radio" && node.props.children === "Priority")!.props.onClick();
  nodes.find(node => node.props["aria-label"] === "Bash timeout")!.props.onChange({ target: { value: "60" } });
  expect(changes).toEqual([
    { field: "model", body: { modelProvider: "anthropic", modelId: "claude-fable-5-1" } },
    { field: "thinking", body: { thinkingLevel: "max" } },
    { field: "speed", body: { speedMode: "priority" } },
    { field: "bash-timeout", body: { bashTimeoutSeconds: 60 } },
  ]);
});
