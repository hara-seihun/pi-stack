# Pi Remote Android 0.55.8: what changed

## The bug you hit
When a thread crossed the compaction threshold, the runtime paused the run,
compacted the context, then resumed with a continuation turn. For a fraction of
a second between the pause and the resume the thread reported `IDLE`, and the
app read that momentary idle as "the agent finished" and fired a completion
notification. Nothing had actually finished.

A second, unrelated glitch: the newest tool card replayed its entrance
animation and collapsed itself every time more streaming output arrived.

## The fix
- The completion tracker now holds any `IDLE` result for one second before it
  notifies. If `COMPACTING` activity or a resumed `RUNNING` state shows up in
  that window, the pending notification is cancelled. Compaction stays silent;
  real completions still notify after the one-second settle.
- `COMPACTING` now counts as an active state, so compaction can never be read
  as completion on its own.
- The most recent tool card updates its arguments, result, timing, and status
  in place without rebuilding its view, so it no longer replays the entrance
  animation or loses its expanded state.

## Status
Built, unit-tested, and launch-verified on the `pi-remote-test` emulator.
Server tests confirm `/v1/sync` reports `state: RUNNING, activity: COMPACTING`
during compaction. Committed and pushed as `6cf4092`.
