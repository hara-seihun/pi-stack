export const FEATURES = {
  chat: { label: "Conversations", coverage: "Accepted messages and conversation opens" },
  agents: { label: "Agents", coverage: "Agent list opens and accepted launches" },
  attention: { label: "Attention", coverage: "Attention screen opens" },
  machine: { label: "Machine", coverage: "Machine screen opens" },
  context: { label: "Context inspection", coverage: "Inspector opens" },
  editor: { label: "Browser editor", coverage: "Editor launches" },
  attachment: { label: "Attachments", coverage: "Completed uploads" },
  artifact: { label: "Artifacts", coverage: "Explicit previews and downloads" },
  drawing: { label: "Drawing", coverage: "Drawing editor opens" },
  speech: { label: "Read aloud", coverage: "Requested utterances" },
  voice: { label: "Voice", coverage: "Accepted Voice connections" },
  meet: { label: "External meetings", coverage: "External meeting launches" },
  telephone: { label: "Telephone errands", coverage: "Accepted agent calls" },
  signal: { label: "Signal tool", coverage: "Accepted tool operations" },
  overlay: { label: "Phone overlay chat", coverage: "Accepted overlay messages and observed enabled state" },
  phone: { label: "Phone control", coverage: "Accepted phone commands" },
  calendar: { label: "Calendar", coverage: "Explicit calendar tool operations" },
} as const;
export type Feature = keyof typeof FEATURES;
export type FeatureActor = "human" | "agent" | "phone";
export type FeatureState = "enabled" | "disabled" | "unavailable";
export type FeatureEvent = { id: string; feature: Feature } & (
  { kind: "use" } | { kind: "state"; state: FeatureState }
);
export type UsageError = { code: "invalid_event" | "storage_unavailable"; message: string };
export type UsageResult<T> = { ok: true; value: T } | { ok: false; error: UsageError };
export type FeatureObservation = {
  actor: FeatureActor; uses: number; lastUsedAt: number | null;
  last7Days: number; previous30Days: number;
  state: { value: FeatureState; observedAt: number } | null;
};
export type FeatureUsageSummary = {
  since: number; asOf: number; retentionDays: 90;
  features: Array<{ id: Feature; observations: FeatureObservation[] }>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseFeatureEvent(input: unknown): UsageResult<FeatureEvent> {
  const invalid = (): UsageResult<FeatureEvent> => ({ ok: false, error: { code: "invalid_event", message: "Expected a feature-use or feature-state event with a UUID; no content fields are accepted" } });
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || !uuid.test(value.id) || typeof value.feature !== "string" || !Object.hasOwn(FEATURES, value.feature)) return invalid();
  if (value.kind === "use" && Object.keys(value).every(key => ["id", "feature", "kind"].includes(key)))
    return { ok: true, value: { id: value.id, feature: value.feature as Feature, kind: "use" } };
  if (value.kind === "state" && typeof value.state === "string" && ["enabled", "disabled", "unavailable"].includes(value.state) && Object.keys(value).every(key => ["id", "feature", "kind", "state"].includes(key)))
    return { ok: true, value: { id: value.id, feature: value.feature as Feature, kind: "state", state: value.state as FeatureState } };
  return invalid();
}
