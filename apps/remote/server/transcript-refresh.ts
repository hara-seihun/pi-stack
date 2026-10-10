import type { SourceError, SourceResult } from "./source-transcripts";

/** A changing native snapshot needs a new projection, not a transport reconnect. */
export async function refreshTranscriptProjection(
  refresh: () => Promise<SourceResult<void>>,
  retry: () => void,
  failed: (error: SourceError) => void,
): Promise<void> {
  const result = await refresh();
  if (result.ok) return;
  if (result.error.code === "conflict") retry();
  else failed(result.error);
}
