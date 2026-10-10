import type { SourceResult } from "./source-transcripts";

export class SourceReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export function sourceValue<T>(result: SourceResult<T>): T {
  if (!result.ok) throw new SourceReadError(result.error.code, result.error.message);
  return result.value;
}

/** A changing native snapshot needs a new projection, not a transport reconnect. */
export async function refreshTranscriptProjection(
  refresh: () => Promise<void>,
  retry: () => void,
  failed: (cause: unknown) => void,
): Promise<void> {
  try {
    await refresh();
  } catch (cause) {
    if (cause instanceof SourceReadError && cause.code === "conflict") retry();
    else failed(cause);
  }
}
