export type InfrastructureReason = "timeout" | "cancelled" | "connection-refused" | "connection-reset" | "invalid-response" | "http-error" | "unexpected" | "resources-unavailable" | "model-unavailable" | "prompt-invariant" | "toolset-invariant" | "no-reply";
export interface InfrastructureEvent {
  component: "root-client" | "root-service" | "root-executor";
  stage: "request" | "admit" | "finalize" | "persist-admission" | "create-session" | "model-turn" | "persist-reply" | "dispose";
  outcome: "ok" | "failed";
  durationMs: number;
  reason?: InfrastructureReason;
  status?: number;
}
export type InfrastructureReporter = (event: InfrastructureEvent) => void;
export const reportInfrastructure: InfrastructureReporter = event => {
  const line = `Kenan infrastructure ${JSON.stringify(event)}`;
  if (event.outcome === "failed") console.error(line);
  else console.info(line);
};
export function infrastructureReason(error: unknown): InfrastructureReason {
  const value = error as { name?: unknown; code?: unknown; cause?: unknown } | undefined;
  if (value?.name === "TimeoutError") return "timeout";
  if (value?.name === "AbortError") return "cancelled";
  if (value?.code === "ECONNREFUSED") return "connection-refused";
  if (value?.code === "ECONNRESET" || value?.code === "EPIPE") return "connection-reset";
  if (value?.name === "SyntaxError") return "invalid-response";
  const cause = value?.cause as { code?: unknown } | undefined;
  if (cause?.code === "ECONNREFUSED") return "connection-refused";
  if (cause?.code === "ECONNRESET" || cause?.code === "EPIPE") return "connection-reset";
  return "unexpected";
}
