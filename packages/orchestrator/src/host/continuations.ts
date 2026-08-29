/**
 * What a session hears when a turn was cut off by the provider rather than
 * by the agent. Two callers reach for it: interactive routing, which moves
 * the session to another account and resumes it, and the fleet host, which
 * waits the provider out and picks the shift back up. Both owe the agent the
 * same three facts — what broke, what was done about it, and that the context
 * in front of it is intact — so both say them the same way.
 *
 * The blame clause is deliberate. An agent handed a bare error at the top of
 * its turn tends to treat it as its own mistake and start over defensively,
 * which is how an hour of good context gets spent re-deriving itself.
 *
 * This file once also generated continuation check-ins — the host re-prompting
 * a session that had ended its turn while the lane still had work. That
 * machinery was removed on 2026-08-29: a shift is now one work turn, and an
 * agent ending its turn ends it. The night it was removed, check-ins had
 * pinned a fleet of drained-queue agents against a folder none of them could
 * finish, unable to work and unable to stop.
 */

export function interruptedTurnPrompt(failure: string, remedy: string): string {
  return (
    "## Your last turn was cut off\n\nNot by you, and not by anything you did — the " +
    `provider failed mid-turn: ${failure.slice(0, 500)}\n\n${remedy}\n\n` +
    "Nothing here was lost. Your reasoning, tool calls, and tool results above are all " +
    "still in context, so pick up exactly where you stopped instead of starting over. " +
    "The one thing worth re-checking is any tool call whose result you never saw: run " +
    "it again before you rely on it."
  );
}

/** Plain English for a wait the agent just slept through, so the message can
 * say what actually happened to the missing minutes. */
export function describeWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}
