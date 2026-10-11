const NATIVE_COMPACTION = "openai-codex-native-compaction";
const failure = (code, message) => ({ ok: false, error: { code, message } });
const isNative = entry => entry.type === "compaction" && entry.details?.kind === NATIVE_COMPACTION;
const conversationMessages = entry => entry.sourceEntry.type === "compaction"
  ? []
  : entry.messages.filter(message => message.role !== "system");

/** Recover prose-summary input from the active branch, without moving its prepared cut. */
export function portableCompactionPreparation(preparation, branchEntries, buildSessionProjection) {
  if (!Array.isArray(branchEntries))
    return failure("portable_history_unavailable", "The active branch history is unavailable");
  const latest = branchEntries.findLast(entry => entry.type === "compaction");
  if (!latest || !isNative(latest)) return { ok: true, value: preparation };
  if (!preparation || typeof preparation.firstKeptEntryId !== "string" ||
      !Array.isArray(preparation.messagesToSummarize) || !Array.isArray(preparation.turnPrefixMessages) ||
      typeof preparation.isSplitTurn !== "boolean")
    return failure("portable_history_invalid_preparation", "The original compaction cut and message partition are required");
  if (typeof buildSessionProjection !== "function")
    return failure("portable_history_projection_failed", "The SDK session projection is unavailable");

  const positions = new Map();
  let parentId = null;
  for (let index = 0; index < branchEntries.length; index++) {
    const entry = branchEntries[index];
    if (typeof entry.id !== "string" || positions.has(entry.id) || entry.parentId !== parentId)
      return failure("portable_history_unavailable", "The active branch has duplicate entries or missing ancestry");
    positions.set(entry.id, index);
    parentId = entry.id;
    if (entry.type === "compaction") {
      const boundary = positions.get(entry.firstKeptEntryId);
      if (boundary === undefined || boundary > index)
        return failure("portable_history_unavailable", `Compaction ${entry.id} has no retained boundary in the active branch`);
      if (isNative(entry) && index === 0)
        return failure("portable_history_unavailable", "The original history preceding the native checkpoint is missing");
    }
  }

  let original;
  let portable;
  try {
    original = buildSessionProjection(branchEntries);
    // Keep the tree nodes so SDK traversal and edits retain their original custody.
    // Only native checkpoint contributions disappear; an earlier prose summary still applies.
    portable = buildSessionProjection(branchEntries.map(entry => isNative(entry)
      ? { type: "custom", customType: "portable-compaction-history-boundary", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp }
      : entry));
  } catch {
    return failure("portable_history_projection_failed", "The SDK could not project the active branch history");
  }
  if (![original, portable].every(projection => Array.isArray(projection?.entries) &&
      projection.entries.every(entry => typeof entry.sourceEntry?.id === "string" && Array.isArray(entry.messages))))
    return failure("portable_history_projection_failed", "The SDK returned an invalid provenance projection");

  const originalCut = original.entries.findIndex(entry => entry.sourceEntry.id === preparation.firstKeptEntryId);
  const portableCut = portable.entries.findIndex(entry => entry.sourceEntry.id === preparation.firstKeptEntryId);
  if (originalCut < 0 || portableCut < 0)
    return failure("portable_history_unavailable", "The original compaction cut is absent from projected history");

  let historyEnd = portableCut;
  if (preparation.isSplitTurn) {
    let prefixCount = preparation.turnPrefixMessages.length;
    let prefixStart = originalCut;
    while (prefixCount > 0 && prefixStart > 0) {
      prefixStart--;
      prefixCount -= conversationMessages(original.entries[prefixStart]).length;
    }
    if (prefixCount !== 0 || prefixStart === originalCut)
      return failure("portable_history_invalid_preparation", "The original split-turn prefix has no exact source boundary");
    const prefixId = original.entries[prefixStart].sourceEntry.id;
    historyEnd = portable.entries.findIndex(entry => entry.sourceEntry.id === prefixId);
    if (historyEnd < 0 || historyEnd > portableCut)
      return failure("portable_history_unavailable", "The original split-turn boundary is absent from portable history");
  } else if (preparation.turnPrefixMessages.length !== 0) {
    return failure("portable_history_invalid_preparation", "A non-split preparation contains a turn prefix");
  }

  const previous = portable.entries.find(entry => entry.sourceEntry.type === "compaction");
  const messagesToSummarize = portable.entries.slice(0, historyEnd).flatMap(conversationMessages);
  const turnPrefixMessages = portable.entries.slice(historyEnd, portableCut).flatMap(conversationMessages);
  if (!previous && messagesToSummarize.length === 0 && turnPrefixMessages.length === 0)
    return failure("portable_history_unavailable", "No portable summary or original conversation exists before the compaction cut");
  return {
    ok: true,
    value: {
      ...preparation,
      messagesToSummarize,
      turnPrefixMessages,
      previousSummary: previous?.sourceEntry.summary,
    },
  };
}
