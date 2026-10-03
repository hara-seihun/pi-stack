# Write final local rewrite

`rewrite.py` owns the final dictation editor; `server.py` invokes it after recognition
and baseline cleanup. [Measured results](rewrite-results/README.md) distinguish
text controls, recorded real ASR, and complete local PCM/WebSocket regressions.
They do not establish installed-phone accuracy or deployed-host behavior.

## Data and lifetime

One resident **Qwen3-4B-Instruct-2507 Q4_K_M** model runs entirely locally in the
pinned CPU-only llama.cpp server. [Runtime installation](../rewrite-runtime/README.md)
owns artifact pins, checksums, licenses, host compatibility and reproducible
preparation. No pooled/cloud inference receives dictation. Public artifact
downloads are installation, not inference.

The engine starts and owns the subprocess, waits for readiness, and warms its
shared prompt cache before accepting dictation. Failure to initialize prevents
engine startup. Shutdown terminates the child and removes its private API key.
The child listens on an ephemeral loopback port with a per-process key; requests
ignore proxy environment settings. Models are not loaded per dictation.

Partials still use [incremental cleanup](cleanup/README.md). At Finish, the editor
receives recognized words after explicit dictionary replacements and canonical
spelling (`dictionary_text`), before disfluency deletion. The cleaned baseline is
kept separately. This preserves self-correction context that baseline cleanup may
remove. Cursor context is not passed to the generative editor. Dictation is a JSON
data field, not an instruction to answer; a system prompt and examples ask for
fluent writing that preserves register, reasons, uncertainty and literal content.
Only dictionary terms already present accompany it as protected spellings; absent
names are never offered as suggestions. The prompt is implementation-owned.

CPU execution uses four threads by default, one server slot and a request lock,
2048 context positions, temperature zero, shared prompt KV caching, and bounded
output (64–384 tokens based on source length). Different people's requests share
the resident runtime; these settings are not a per-person model session.

## Guard decisions and limits

`Decision` contains text, status, reason and latency. Accepted text is `applied`
if it differs from the cleaned baseline, otherwise `unchanged`. A `guarded` or
`unavailable` decision returns that baseline with an explicit reason, never
silently pretends a rewrite succeeded.

Protection rejects:

- Chat control input (`<|`), more than 256 lexical tokens or 2400 characters.
- Non-stop generation, empty output, model control markers or excessive expansion.
- Changes to digit sequences relative to the authorized cleaned baseline, and
  changes to literal straight/smart double-quoted spans relative to source.
- Changes in negation counts (with bounded self-correction `no` exceptions),
  deletion of selected uncertainty/opinion markers, or changed explicit line layout.
- Reversion of quoted content already formatted by the baseline from spoken controls.
- Changed occurrence counts of configured dictionary phrases, including inserting
  a dictionary name absent from the source.
- Large lexical drift according to a sequence-overlap heuristic.

These are bounded protections, **not semantic equivalence proof**. A model can
still alter an unprotected name, attribution, uncertainty, comparison or fact
while retaining enough words to pass. Conversely, the guard can reject a valid
paraphrase or correction. It cannot recover speech the recognizer missed, resolve
all ambiguous alternatives, or guarantee acoustic name recognition. A rewritten
question/request remains text; it must not be answered by the editor.

The lock waits at most 8 seconds; local HTTP inference has an 18-second timeout.
A busy queue, stopped runtime or failed response reports `unavailable`. Guard
failures report their own machine-readable reason. Startup readiness has a
separate 20-second bound. These bounds are not promised per-dictation latency.

## Client contract and timing

The final frame includes `rewrite: {status, reason, latencyMs}`.
`raw` and recognition `words` remain unchanged. When accepted rewrite changes the
baseline, `edits` becomes a whole-source `kind: "rewrite"` receipt with baseline
`from`, rewritten `to`, and half-open source indices; it is not a detailed
word-by-word rewrite alignment. [Write's wire owner](../../remote/docs/write.md)
describes client behavior. Both clients show a notice for guarded/unavailable
outcomes while inserting the cleaned baseline. A null `rewrite` is possible on an
engine instance constructed without a rewriter, not an accepted rewrite result.
Meeting transcription sends `rewrite: false` on internal engine Start: it needs
raw recognition, not an editor or unnecessary generation delay.

This final stage is seconds-scale, unlike the recognition-only 100 ms flush
objective. `timing.flushMs` includes recognizer drain, baseline cleanup and rewrite;
`rewrite.latencyMs` isolates rewrite queue/inference time. Native Android waits up
to 30 seconds after wire Finish. Speculative recognition/cleanup does not eliminate
final rewrite latency. Seven exposed live pipeline sessions measured
1.15–2.24 seconds; this is a bounded regression, not a general latency SLA.

## Reproduce

From the repository root, run guard/wire tests without loading the model:

```sh
PY=/srv/pi/write-engine/venv/bin/python
(cd apps/write/engine && $PY -m unittest test_rewrite test_rewrite_stream -q)
```

For a prepared runtime and model, benchmark a bounded authored-text slice:

```sh
$PY apps/write/engine/benchmark_rewrite.py \
  --binary /srv/pi/write-engine/rewrite-runtime/llama-server \
  --model /srv/pi/write-engine/rewrite-model/model.gguf \
  --start 0 --count 2 --output /tmp/write-rewrite-text.jsonl
```

The benchmark uses the deployed cleanup/punctuation models for its baseline;
record those identities alongside the candidate source/model. `--count` permits
1–20 cases; `--start` selects smaller bounded slices. Text controls are not
acoustic or untouched holdout proof. Paths above require a prepared engine containing the
new runtime/model links; do not infer deployment from these example paths.

Replay the two new synthetic acoustic controls against an already-running
candidate engine (supply its endpoint with `--url`):

```sh
$PY apps/write/eval/evaluate.py replay \
  --id rewrite-color --id rewrite-intent --limit 2 --final-timeout 30 \
  --output /tmp/write-rewrite-audio.jsonl
$PY apps/write/eval/evaluate.py score --output /tmp/write-rewrite-audio.jsonl
```

[Audio evaluation](../eval/README.md) owns all 21 licensed fixtures (13 real AMI,
8 synthetic), raw/clean separation, dictionary negatives and meaning-proxy limits.
The guards and mock wire tests do not establish full corpus success, physical
Android microphone behavior or deployed latency.

## Evidence owners

- [Host/Android reliability evidence](/home/kenan/data/voice-write-reliability/README.md)
  owns operational receipts, terminal-word diagnosis and earlier comparisons.
- [Audio baseline](../eval/README.md#live-cpu-baseline-not-candidate-fix-evidence)
  predates this rewrite and its two new controls; preserve it as baseline evidence.
- [Rejected Mumble candidate](../local-rewrite/README.md) and the
  [cleanup owner](cleanup/README.md) retain earlier task-trained/0.6B comparisons.
  Their results do not measure this Qwen 4B path.

[Current receipts](rewrite-results/README.md) name source/model/runtime and corpus
identities, distinguish authored controls from real ASR, and report guard outcomes.
Returned-output success includes explicit baseline retention, not model success.
Natural-target WER increases in this bounded set despite more fluent output;
general rewriting and unfamiliar-name accuracy remain unproven.
