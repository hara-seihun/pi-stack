export const SPEEDS = ["standard", "priority", "ultrafast"] as const;
export type Speed = typeof SPEEDS[number];
export const isSpeed = (value: unknown): value is Speed => SPEEDS.some(speed => speed === value);

export function requestedSpeedError(model: { provider: string; id: string } | undefined, speed: unknown): string | undefined {
  if (!isSpeed(speed)) return `Invalid thread speed: ${String(speed)}`;
  if (speed === "standard" || modelSpeedModes(model?.provider ?? "", model?.id ?? "").includes(speed)) return;
  return speed === "ultrafast" ? "Ultrafast speed requires OpenAI Codex Astra" : `Priority speed is unavailable for ${model?.provider ?? "unknown"}/${model?.id ?? "unknown"}`;
}

export function modelSpeedModes(provider: string, id: string): Speed[] {
  if (provider.replace(/-\d+$/, "") !== "openai-codex") return [];
  return /(^|[-_.])astra([-_.]|$)/i.test(id) ? [...SPEEDS] : ["standard", "priority"];
}
