export const NATIVE_PROTOCOL = "batch-operations-v1";

/** An absent version is usable only to drain a registered predecessor, never for new input. */
export function nativeProtocol(state: Record<string, unknown>, retained: boolean): "current" | "draining" {
  if (state.nativeProtocolVersion === NATIVE_PROTOCOL) return "current";
  if (state.nativeProtocolVersion !== undefined) throw new Error(`Unsupported native protocol: ${String(state.nativeProtocolVersion)}`);
  if (!retained) throw new Error("Fresh native runner did not identify its batch/operation protocol");
  for (const key of ["acceptedWorkIds", "landedWorkIds", "completedWorkIds"]) {
    if (!Array.isArray(state[key]) || !(state[key] as unknown[]).every(id => typeof id === "string"))
      throw new Error(`Retained runner cannot prove exact ${key}; custody preserved without replay`);
  }
  if (typeof state.isStreaming !== "boolean") throw new Error("Retained runner cannot prove execution activity");
  return "draining";
}
