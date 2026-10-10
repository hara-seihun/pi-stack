import type { SourceError, SourceResult } from "./source-transcripts";
import { historySourceChanged } from "../shared/history-source-retry";

/** A changing native snapshot needs a new projection, not a transport reconnect. */
export async function refreshTranscriptProjection(
  refresh: () => Promise<SourceResult<void>>,
  retry: () => void,
  failed: (error: SourceError) => void,
): Promise<void> {
  const result = await refresh();
  if (result.ok) return;
  if (historySourceChanged(result.error)) retry();
  else failed(result.error);
}
