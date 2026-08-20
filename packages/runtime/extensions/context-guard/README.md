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

One uniform rule set for all providers and models (models whose window is
smaller than the trigger are pi's stock domain — the trigger simply never
fires for them):

- **Trigger:** projected prompt ≥ **250k** tokens → cut before sending.
  Guarantees Sol/Luna never bill the 272k tier (22k margin covers estimator
  error and single-step bursts).
- **Rung 1 — evict tool results** older than the tail: body replaced by a
  short placeholder naming the tool. A single notice message after the head
  carries the greppable transcript path once for the whole view — repeating
  the path in hundreds of placeholders measurably raised the post-cut floor.
  Tool-call arguments are kept verbatim (they are the artifact trail).
- **Rung 2 — strip old reasoning**: thinking blocks removed from old
  assistant messages, along with all provider validation metadata
  (`thinkingSignature`, `textSignature`, `|item-id` suffixes on tool-call ids).
  Legal on both providers: Anthropic validates only the latest assistant
  message; OpenAI validates only ID-bearing replays.
- **Rung 3 — handoff summary** when rungs 1–2 would land above **125k**
  (unevictable residue accumulates ~10% of throughput; only marathon runs hit
  this). The lower threshold reserves the measured 10–20k of provider-visible
  system/tool overhead that is absent from the transformed-message estimate.
  The model writes a structured handoff *in-conversation* (cache-hot, sees full
  tool results), which then replaces the summarized span. User messages in
  that span are preserved verbatim. The summary call requests **low reasoning
  effort**: at the session's own effort (research lanes run xhigh) reasoning
  can consume the entire output budget and return zero text. If the account is
  exhausted, the call errors, or it returns no text, a provider-independent
  hard-compaction message replaces the same span. The original user messages,
  50k verbatim tail, and transcript pointer remain; cap enforcement never
  depends on a second successful provider call.
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

## Guards (both write to the alerts inbox, `/home/kenan/data/alerts/inbox/`)

- **Thrash:** two cuts within 10 LLM calls in one session. This is the
  failure mode of Anthropic's 2026-04-23 Claude Code postmortem (a `keep:1`
  thinking-clear that fired every turn). The cap stays enforced; the alert
  demands investigation.
- **Floor:** after a cut, the provider *actually bills* more than trigger − 100k,
  i.e. the pinned head or residue is too large. Expect thrashing until fixed.
  The check waits for the next real `getContextUsage()` anchor rather than
  scaling its own view estimate by the ratio: at the first cut of a session the
  ratio is still the uncalibrated 1.6 prior, which overstated one measured
  Opus landing (129k billed) as 154k and raised a false alert. Every cut logs
  its projection and estimated landing to stderr, so the journal still shows
  near-floor cuts that never breached.

## Calibration

Byte-based token estimates undercount (Anthropic bills ~1.5–2.5× the byte/4
estimate). The guard calibrates an estimate→billed ratio per session from real
usage (`ctx.getContextUsage()`), blended 50/50 per observation, clamped to
[1.0, 3.0], initialized at 1.6. While the usage anchor is stale (right after a
cut, before the next response), the guard dead-reckons from its own view
estimate instead of the anchor.

## Parameters (in `plan.mjs`)

| knob | value | provenance |
|---|---|---|
| trigger | 250k | 272k tier − margin; inside the 239–453k quality plateau; sim: 55% of uncapped Sol cost |
| tail | 50k billed (÷ calibration ratio at cut time) | LangWatch: 30–60k verbatim tail is the single biggest quality lever; +2.5 cost points vs 20k |
| residueMax | 125k transformed messages | leaves room for measured provider-visible system/tool overhead below the 150k floor; still inside the simulation's flat 100k–180k range |
| floorHeadroom | 100k | Opus@150k/80k-tail simulated at 160% of uncapped — thrash territory |
| quietSteps | 10 | thrash guard window |

## Escape hatch

`PI_CONTEXT_GUARD=off` in the environment disables all behavior.

## Known limitations

- State is in-memory per session process. After a host restart/adoption the
  guard re-derives the cut on the first context event (deterministic; costs
  one extra cache miss).
- The floor guard needs one post-cut usage anchor, so a session that ends
  immediately after its cut is never judged. That is deliberate: without a
  billed measurement there is no evidence of a floor problem.
- pi-usage-logger's `context_bytes` measures the transformed view (this
  package loads before it in `settings.json`), but its `context_hash`
  fingerprints change on each cut boundary advance.
- The rung-3 summary call routes through the session's model registry with
  the same session id; on Anthropic the prefix cache is content-addressed so
  the call is cache-hot, on Codex cache affinity follows `prompt_cache_key`.

## Validation (passive)

```sql
-- must be zero after rollout
SELECT COUNT(*) FROM request
WHERE model LIKE 'gpt-5.6%' AND input_tokens + cache_read_tokens > 272000
  AND started_at > <rollout_ms>;

-- overflow compactions should collapse to ~zero
SELECT reason, COUNT(*) FROM usage_event
WHERE kind='compaction' AND at > <rollout_ms> GROUP BY reason;
```

Watch lane verdict rates in research-bench. If Opus quality dips, **lower**
the trigger (better compactor ⇒ lower optimum), don't raise it.

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
