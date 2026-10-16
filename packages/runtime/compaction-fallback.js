const modelIdentity = model => ({ provider: model.provider, id: model.id, api: model.api });
const errorData = error => ({ name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) });

export function selectCompactionFallback(model, available) {
  const candidate = model.id === "gpt-6.1-sol"
    ? available.find(other => other.id !== "gpt-6.1-sol" && (other.api !== model.api || other.id !== model.id))
    : available.find(other => other.provider === "openai-codex" && other.id === "gpt-6.1-sol");
  return candidate ? { ok: true, value: candidate } : { ok: false, error: {
    code: "compaction-fallback-unavailable",
    message: model.id === "gpt-6.1-sol" ? "No different installed, authenticated compaction model is available" : "Compaction fallback openai-codex/gpt-6.1-sol is unavailable",
  } };
}

/** One original attempt and at most one alternate; neither changes the conversation model. */
export async function runCompactionWithFallback({ model, availableModels, signal, primary, fallback, record }) {
  let originalFailure;
  let fromExtension = false;
  try {
    if (signal.aborted) return { state: "cancelled", error: signal.reason };
    const original = await primary();
    if (signal.aborted || original.state === "cancelled") return { state: "cancelled", error: signal.reason ?? new Error("Compaction cancelled") };
    return { state: "ready", value: { ...original.value, details: { ...original.value.details,
      compactionProducer: { ...modelIdentity(original.model ?? model), route: "primary" } } }, fromExtension: original.fromExtension };
  } catch (error) {
    if (signal.aborted) return { state: "cancelled", error };
    originalFailure = errorData(error);
    fromExtension = error?.compactionFromExtension === true;
  }
  const originalModel = modelIdentity(model);
  record({ state: "primary-failed", originalModel, error: originalFailure });
  const selected = selectCompactionFallback(model, availableModels());
  if (!selected.ok) {
    record({ state: "unavailable", originalModel, originalFailure, error: selected.error });
    return { state: "failed", fromExtension, error: { ...selected.error, originalFailure } };
  }
  const alternate = selected.value;
  const fallbackModel = modelIdentity(alternate);
  try {
    if (signal.aborted) return { state: "cancelled", error: signal.reason };
    const result = await fallback(alternate);
    if (signal.aborted) return { state: "cancelled", error: signal.reason };
    record({ state: "recovered", originalModel, originalFailure, producer: fallbackModel });
    return { state: "ready", value: { ...result, details: { ...result.details,
      compactionProducer: { ...fallbackModel, route: "fallback" },
      compactionFallback: { originalModel, originalFailure } } }, fromExtension: false };
  } catch (error) {
    if (signal.aborted) return { state: "cancelled", error };
    const fallbackFailure = errorData(error);
    record({ state: "failed", originalModel, originalFailure, fallbackModel, error: fallbackFailure });
    return { state: "failed", fromExtension, error: { code: "compaction-fallback-failed", originalFailure, fallbackFailure,
      message: `Original compaction failed: ${originalFailure.message}; fallback ${alternate.provider}/${alternate.id} failed: ${fallbackFailure.message}` } };
  }
}
