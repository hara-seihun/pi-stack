export const SPEEDS = ["standard", "priority", "ultrafast"] as const;
export type Speed = typeof SPEEDS[number];
export const isSpeed = (value: unknown): value is Speed => SPEEDS.some(speed => speed === value);

export function modelSpeedModes(provider: string, id: string): Speed[] {
  if (provider.replace(/-\d+$/, "") !== "openai-codex") return [];
  return /(^|[-_.])astra([-_.]|$)/i.test(id) ? [...SPEEDS] : ["standard", "priority"];
}
