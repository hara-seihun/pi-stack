# Published Mumble int8 ONNX: do not ship

Measured October 3, 2026 on kenan-server, AMD Ryzen 7 PRO 8700GE,
CPUExecutionProvider only. This is a bounded negative for the **published int8
artifact at the pinned revision and this greedy runtime**, not a verdict on small
local models, its float32 export, retraining, or contextual rewriting generally.
No production configuration changed.

## Fixed comparison

The baseline imports the **currently deployed** `/srv/pi/write-engine/cleanup`,
with its resident joint deletion tagger **and deployed punctuation model**, not
rules-only code or old report outputs. Resolved deployment path, load time,
warmup output and package versions are retained in each batch receipt. Model
load/prefill warmup are excluded from per-request timing; each batch loads once,
warms the candidate with `um hello`, then evaluates 2–3 requests. Baseline calls
are not separately warmed. Two CPU threads per resident model; no GPU.

The slice contains three actual Nemotron transcripts derived from public test
**audio already evaluated by this project**, two public **verbatim validation
texts** (not audio or ASR), and six **authored** controls. The literal provided
`nemotron-public.jsonl` is a test-derived corpus, not fresh ASR validation; it is
explicitly named `real_audio_asr_previous_test_diagnostic`. Inputs, source row
indices and hashes are frozen in this directory. No audio was re-recognized in
this experiment; ASR audio provenance/revision limits are documented in
`/home/kenan/work/pi-stack-write/cleanup/REPORT.md`. No held-out test training,
prompt edits, threshold tuning, or sampling search was performed.

Metric: case-insensitive Levenshtein over words/contractions and punctuation,
divided by gold tokens. Exact also ignores case. All generated text is scored,
including a partial output on the one generation-limit failure; that failure
is separately counted and **not a valid response**. P95 is nearest-rank and,
with these tiny groups, means the maximum; it is not a production SLA estimate.

| Group | N | Deployed errors/gold | Candidate errors/gold | Exact deployed/candidate | Latency p50 deployed/candidate | Latency p95 deployed/candidate |
|---|---:|---:|---:|---:|---:|---:|
| Real audio → existing ASR | 3 | 13/64 (20.3%) | 28/64 (43.8%) | 0/0 | 19/1209 ms | 32/1511 ms |
| Verbatim validation text, not ASR | 2 | 2/44 (4.5%) | 3/44 (6.8%) | 0/1 | 23/1515 ms | 24/1650 ms |
| Authored controls | 6 | 7/49 (14.3%) | 155/49 (316.3%) | 3/0 | 19/1432 ms | 60/6425 ms |

On real ASR the candidate loses all three examples. It preserves some fillers
that the gold removes and turns the microwave/bowl utterance into
`In a like a shot, do you call it like Pyrrhic?`, deleting most of the message.
Its one genuine win is a verbatim-text typo correction (`pointeger` → `point`).
That is evidence of contextual correction ability, but not a net product win.

## Authored safety controls

- **Negation:** both preserve the meaning. Candidate changes `do not` → `don't`,
  causing two token errors under a copy-oriented gold despite semantic validity.
  The required-content probe accepts either form. Its initial lexical check was
  corrected to accept contractions; generation, outputs and timings were not rerun.
- **Date repair:** deployed removes Monday after `wait no Thursday`; candidate
  keeps both alternatives and the correction markers.
- **Exact identifiers:** both retain `001007 not 1007`, adding a comma. These are
  literal text identifiers, not spoken digit audio, so they prove no acoustic
  number handling or dictionary probability calibration.
- **Quoted fillers:** candidate preserves `"uh um"` with an extra colon. Deployed
  deletes the literal string. This baseline defect is reported to the integration
  owner for repair, not hidden by the negative model result.
- **Dictionary names:** deployed preserves Hara, Seihun, Kelana, Nebulani;
  candidate responds `I'm sorry, but I can't assist with that...`. The candidate
  receives correct names in the transcript, not a custom dictionary prompt.
- **Publisher's basic example:** candidate reproduces the system instruction
  then repeats `er` until the 128-token cap (6.425s); deployed also mishandles it,
  outputting `So think we should ship this on friday?`.

Required-content checks pass 4/6 deployed versus 3/6 candidate; these are lexical
adversarial probes, not a comprehensive semantic equivalence metric. Candidate
has one explicit generation-limit failure, deployed has none. Candidate's other
five authored cases have 30 token errors/40 gold, so rejection does not depend
only on charging for the runaway partial output.

## Runtime boundary and remaining uncertainty

The no-tools prompt was checked against the publisher's Jinja template; tokenizer
special IDs match 151644/151645, no hidden padding/truncation. ONNX input/output
signatures were inspected: 24 layers, 2 KV heads, head dimension 64, float32 caches;
output order is `logits, present.0.key, present.0.value, ...`. A two-step cached
versus full-prefix check for `um hello` produced the same second greedy token
(comma) but maximum logit difference 5.9813; dynamic int8 quantization can change
values across input shapes. No float32 parity assertion is claimed, and no
multi-gigabyte float32 download or speculative workaround search was undertaken.

The production cleanup flush allowance in the prior report is 40ms. Even the
successful candidate requests take 0.7–2.3 seconds and cannot meet it here.
Weights/tokenizer reside only in the documented rebuildable cache. The
experiment's adapter remains opt-in; no automatic production fallback and no
cloud/pool call exists. This candidate cannot provide meaningful dictionary
probabilities from the observed refusal/looping behavior. Fresh real Write
recordings and independently corrected gold are still needed before choosing a
better local contextual model.
