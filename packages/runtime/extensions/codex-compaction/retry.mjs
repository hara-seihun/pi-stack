/**
 * A failed automatic compaction fences that model's requests only until its retry time. The fence grows
 * exponentially with consecutive failures since the last committed compaction and never becomes permanent:
 * on October 3, 2026 one "servers are currently overloaded" response wedged the OV integrator for hours
 * because the fence waited for a manual /compact that nothing would ever send.
 */
export function compactionRetryAt(failedAt, failures) {
  return failedAt + Math.min(60_000 * 2 ** Math.max(0, failures - 1), 30 * 60_000);
}
