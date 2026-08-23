# context-guard

Mid-run context cap for every pi session on this machine. pi's own compaction
check runs only at `agent_end` and before a new user prompt, so an autonomous
run (one prompt, hundreds of tool calls) historically grew to 600–900k tokens —
deep into GPT-5.6's 2× price tier at 272k input tokens and far past every
measured effective-context knee. This extension enforces a cap at the `context`
event, which fires before **every** LLM call, including the first call of a
resumed or forked session.

Strategy evidence and simulations: [`memory/agent-context-compaction.md`](/home/kenan/memory/agent-context-compaction.md).
(The strategy simulation scripts were deleted with the superseded Pi usage
telemetry ledger they read; their conclusions are recorded in that memory file.)

## Behavior

One rule set covers providers whose request history is client-authored (the
builtin Anthropic and OpenAI families). Cursor is excluded: its Connect
transport continues a server-side conversation, and the 2026-08-20 incident
showed a transformed 65k client view still billing 281k on the next
continuation. Pretending the cap applied there produced a catastrophic false
floor diagnosis; Cursor has no corresponding 272k price tier, so its provider
must own any future server-side compaction. Models whose window is smaller
than the trigger remain pi's stock domain — the trigger simply never fires for
them.

- **Trigger:** projected prompt ≥ **250k** tokens → cut before sending.
  Guarantees Sol/Luna never bill the 272k tier (22k margin covers estimator
  error and single-step bursts).
- **Rung 1 — evict tool results** older than the tail: body replaced by a
  short placeholder naming the tool. A single notice near the head tells the
  model that it has just been compacted, has substantial headroom again, and
  is in a good position to keep working regardless of the earlier transcript
  length. It also carries the greppable transcript path once for the whole
  view — repeating the path in
  hundreds of placeholders measurably raised the post-cut floor. Tool-call
  arguments are kept verbatim (they are the artifact trail).
- **Rung 2 — strip old reasoning**: thinking blocks removed from old
  assistant messages, along with all provider validation metadata
  (`thinkingSignature`, `textSignature`, `|item-id` suffixes on tool-call ids).
  Legal on both providers: Anthropic validates only the latest assistant
  message; OpenAI validates only ID-bearing replays.
- **Rung 3 — handoff summary** when rungs 1–2 would land above **125k**
  (unevictable residue accumulates ~10% of throughput; only marathon runs hit
  this). The lower threshold reserves provider-visible system/tool overhead
  that is absent from the transformed-message estimate. The model writes a
  structured handoff from the already transformed rungs-1–2 candidate, which
  then replaces the summarized span. The auxiliary call never receives the
  oversized raw history; if even the transformed candidate projects above the
  250k trigger, the guard skips that call and hard-compacts deterministically.
  User messages in the span are preserved verbatim. The summary call requests
  **low reasoning effort**: at the session's own effort (research lanes run
  xhigh) reasoning can consume the entire output budget and return zero text.
  If the account is exhausted, the call errors, or it returns no text, a
  provider-independent hard-compaction message replaces the same span. The
  original user messages, 50k verbatim tail, and transcript pointer remain;
  cap enforcement never depends on a second successful provider call.
- **Protected head:** a host can register a leading span of messages whose
  *voice* crosses every cut byte-identical — user text, assistant text,
  thinking, and signatures — by setting `globalThis.__piContextGuardProtect`
  (a `Map<sessionId, messageCount>`) before the first cut. Rung 2,
  summarization, and the tail boundary all begin after the span; the guard
  reads the map fresh at each context event and defaults to protecting only
  message 0. The registrant is the pi-orchestrator's opening-pin extension:
  frontier lanes open with a lived exchange the agent must keep recognizing
  as its own words.

  **Rung 1 still applies inside the head.** A tool result is not the agent's
  words, and a host cannot bound what its opening reads: each opening prompt
  is answered with real, unbounded tool use, so the math fleet's pinned
  openings measured **87–91% tool-result bytes** — 84–119k billed tokens of a
  250k cap, on every request, for the session's whole life. That put the floor
  at 150–193k, *above the floor alert's own 150k threshold*, so every cut in
  those lanes alerted and the ~95k of working room left under the trigger ran
  out in about ten steps, which is the thrash guard's window. Evicting the
  head's tool payloads drops it to ~11–12k billed and preserves the entire
  stated purpose. Replayed over 40 math-fleet sessions: landing p90 236k →
  114k, floor breaches 27 → 0, thrash pairs 8 → 2.

  The span is also honored only as far as its post-eviction cost fits
  `headMax`; beyond that the guard keeps the leading prefix that fits and
  files a **protected head clamped** alert. A host-supplied message count must
  not be able to spend the cap.
- **Verbatim tail:** the most recent **50k billed** tokens cross every cut
  byte-identical — thinking blocks, signatures, and item IDs included. The
  planner accumulates estimator units, so the guard divides the tail budget by
  its calibration ratio; without that, Sol's ~1.9× estimate→billed ratio
  turned the "50k" tail into ~93k billed and pushed the floor to ~154k (the
  2026-08-19 floor breach). The tail boundary never separates a tool result
  from its call.
- **Deep and rare:** ordinary cuts land at ~100–125k; a failed handoff lands
  near the 50k tail instead of above the floor. Cuts then stay quiet for ~30+
  steps.
  Transforms are monotone and deterministic, so the edited prefix is stable:
  one cache miss per cut, then the provider cache re-forms.

## Guards (both write to the alerts inbox, `/var/lib/machine-alerts/inbox/`)

- **Thrash:** two cuts within 10 LLM calls in one session. This is the
  failure mode of Anthropic's 2026-04-23 Claude Code postmortem (a `keep:1`
  thinking-clear that fired every turn). The cap stays enforced; the alert
  demands investigation.
- **Floor:** after a cut, the cut request *actually bills* more than trigger −
  100k, i.e. the pinned head or residue is too large. Expect thrashing until
  fixed. The alert carries the cut view's component breakdown — head,
  transformed span, summary, tail — because the largest component is the thing
  to fix, and reconstructing it after the fact costs a full session replay.
- **Protected head clamped:** the host registered more leading messages than
  `headMax` covers even after their tool results were evicted. The cap holds
  and the session is healthy; the host is pinning more than it can afford, and
  the agent will not see the tail of its own opening. Each outgoing view is paired with the very next persisted assistant
  response, and prompt tokens are read directly as input + cache read + cache
  write. Error and aborted responses still count because providers bill their
  prompt; this avoids both estimating a floor from an uncalibrated ratio and
  mistaking an older successful response for the cut. Every cut logs its
  projection and estimated landing to stderr, so the journal still shows
  near-floor cuts that never breached.

## Calibration

Byte-based token estimates undercount (Anthropic bills ~1.5–2.5× the byte/4
estimate). The guard pairs each outgoing transformed view with the next
assistant response and calibrates estimate→billed-prompt ratio from that exact
pair, blended 50/50 after the first observation and clamped to [1.0, 3.0]. It
never calibrates a raw resumed view against historical usage from a different,
previously transformed view. A fresh session starts at the 1.6 prior; an
existing session adopted after restart/reload starts conservatively at 3.0
until its first matched response. Model switches invalidate calibration.

## Parameters (in `plan.mjs`)

| knob | value | provenance |
|---|---|---|
| trigger | 250k | 272k tier − margin; inside the 239–453k quality plateau; sim: 55% of uncapped Sol cost |
| tail | 50k billed (÷ calibration ratio at cut time) | LangWatch: 30–60k verbatim tail is the single biggest quality lever; +2.5 cost points vs 20k |
| residueMax | 125k transformed messages | leaves room for measured provider-visible system/tool overhead below the 150k floor; still inside the simulation's flat 100k–180k range |
| floorHeadroom | 100k | Opus@150k/80k-tail simulated at 160% of uncapped — thrash territory |
| headMax | 40k estimator units, post-eviction | a pinned opening's own words measured ~8.6k; the budget leaves a host room to pin far more prose than any observed lane while keeping the head off the cap |
| quietSteps | 10 | thrash guard window |
| initialRatio | 1.6 fresh / 3.0 adopted history | normal prior for a new session; fail-safe until a resumed view has one matched response |

## Escape hatch

`PI_CONTEXT_GUARD=off` in the environment disables all behavior.

## Known limitations

- State is in-memory per session process. After a host restart/adoption the
  guard re-derives the cut on the first context event (deterministic; costs
  one extra cache miss).
- The floor guard needs the assistant response to the cut request, so a session
  that ends before any response is persisted is never judged. That is
  deliberate: without billed usage there is no evidence of a floor problem.
- The rung-3 summary call routes through the session's model registry with
  the same session id and receives the transformed candidate rather than the
  oversized raw history. On Codex cache affinity follows `prompt_cache_key`.

## Runtime validation

Inspect cut projections, measured floor alerts, and thrash alerts in the owning
service journal. Every cut logs its projection, its estimated landing, and the
breakdown of where that landing's tokens are:

```bash
journalctl -u pi-remote -S today --no-pager | rg 'context-guard'
journalctl -u pi-orchestrator-runner -S today --no-pager | rg 'context-guard'
```

Use `-S`/`--since` with an explicit `YYYY-MM-DD HH:MM:SS`. `--since "today
00:00"` is **not** valid journalctl syntax: it exits non-zero with `Failed to
parse timestamp`, and inside a pipeline that reads as "no matches" rather than
as an error. That silence is what made these alerts look undiagnosable.

The session JSONL assistant usage is the billing source of truth for a specific
request: prompt tokens are `input + cacheRead + cacheWrite`, including on
`error` and `aborted` responses.

## Tests

```bash
node --test
```

## Rollout

Sessions load this extension at start and cache it for their lifetime. After
changing this package, new interactive sessions pick it up immediately, and
orchestrator-hosted sessions pick it up after `pi-orchestrator drain-runners`
cycles the runner onto fresh code. An edited file on disk does **not** reach
lanes running in an existing session host — the 2026-08-19 floor alerts kept
firing for 15 minutes after the fix was committed because the host predated
the commit.
