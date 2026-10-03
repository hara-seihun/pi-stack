# Write public-audio regression corpus

This owner contains fixtures, replay, and measurements only. It does not change recognition or implement a meaning-aware rewrite. The corpus is deliberately small: **13 actual AMI meeting recordings plus 6 explicitly synthetic domain/dictionary controls**, 75.56 seconds, about 2.4 MB of mono 16 kHz PCM16 WAV. No private speech or files are used.

## Run

From the repository root, use the engine's environment (Python 3.10+ and `websockets>=14`):

```sh
PY=/srv/pi/write-engine/venv/bin/python
$PY apps/write/eval/evaluate.py check
$PY -m unittest discover -s apps/write/eval -q

# Sequential paired replay, ~9 seconds, no model initialization in the client.
$PY apps/write/eval/evaluate.py replay --id ami-1016 \
  --output /tmp/write-filler.jsonl

# A bounded meaningful set, max concurrency remains one.
$PY apps/write/eval/evaluate.py replay \
  --id ami-4062 --id ami-11072 --limit 2 --output /tmp/write-semantic.jsonl

# Compare immediate finish to a conservative energy-trimmed endpoint and
# 400 ms of transmitted silence. This is not a load test.
$PY apps/write/eval/evaluate.py replay --id ami-25 --finish all \
  --output /tmp/write-tail.jsonl

$PY apps/write/eval/evaluate.py score --output /tmp/write-tail.jsonl
```

`--url` selects another running engine (default `ws://127.0.0.1:8797`). `--dictionary off|on|paired`, `--chunk-ms 20|40|200`, and `--pace realtime|burst` expose independent transport conditions. `--limit` defaults to **one fixture**, even with multiple `--id` arguments: increase it explicitly. `--offset` permits bounded slices of the manifest. `--require-pass` turns failed desired expectations into exit status 1; without it, a successful measurement may report failed engine expectations. Operational errors exit nonzero and are not substituted with cleanup-only results.

The client sends `start` with dictionary and PCM format, binary frames, then `finish`; it concurrently drains partials and waits for the engine's distinct `raw` and `text` final. It never waits for a partial per frame. All transmitted PCM is drained before `finish`. `realtime` places finish at the final transmitted sample's clock deadline. `burst` measures queued-audio draining, **not** the streamed finish SLA. No Opus encoding, recorder/UI testing, or concurrent stress is implied.

Finish variants:

- `immediate`: unmodified fixture samples, no extra silence or delay.
- `tight`: removes trailing 10 ms windows with RMS <= .0003, retaining a 20 ms guard. The receipt records removed samples. This conservative energy heuristic is **not** an annotated final-phoneme boundary and can remove nothing.
- `silence`: appends 400 ms of zero PCM before finish. In realtime mode this adds real elapsed time; a low final latency after that is not immediate-finish success.

All audio is committed. For missing **natural** audio, `fetch` queries its recorded dataset row, verifies audio identity and source transcript, downloads at most 2 MB per request, checks the original SHA256, converts with ffmpeg, and checks the committed PCM WAV SHA256 before installation:

```sh
$PY apps/write/eval/evaluate.py fetch --id ami-25
# Optional synthetic regeneration; never replaces AMI recordings.
python3 apps/write/eval/synthetic.py --check
```

The fetcher uses renewable Hugging Face dataset-viewer URLs rather than committing expiring signed links. Audio and transcript checksums/identities, not mutable row position alone, pin the fixture. Upstream changes fail loudly. Conversions require `ffmpeg`; synthetic regeneration requires eSpeak NG **1.52.0**, `en-gb`, 155 words/minute, and ffmpeg. Different generator outputs fail `--check`; regeneration is an explicit corpus change, not an automatic repair.

## Reference contracts

`manifest.json` is the source of truth:

- `verbatim` / `source.transcript`: AMI's original orthographic reference, copied unchanged. It retains repetitions and cutoff fragments such as `Y`, `TH`, and `R`, but does not provide a phonetic transcript or uniformly hyphenate cutoffs. Synthetic verbatim references are generator input text, not human transcripts.
- `target`: **authored desired cleanup**, distinct from the verbatim reference; not an AMI gold clean transcript. It may remove fillers, repeats, and an unambiguous abandoned clause. Ambiguous alternatives are preserved: `ami-10097` retains **third or second floor**, rather than guessing the speaker meant only second.
- `dictionary_target`: explicitly authorized dictionary spelling/replacement when enabled. `replacement-positive` expects `Open lantern works.` without the dictionary and `Open LanternWorks.` with it; recognition is still scored against the same spoken reference.
- `expectation: strict`: exact cleaned spelling, capitalization and punctuation (`formatted_exact`), plus meaning checks and zero unexpected dictionary names.
- `expectation: meaning`: required phrase alternatives, no forbidden abandoned phrase, and zero unexpected dictionary names. Different wording/punctuation may pass even with nonzero cleaned WER.
- `meaning.required`: each list is an OR of accepted surface forms; every list must be satisfied. `meaning.forbidden`: prohibited surface phrases. These are **bounded lexical protections, not a semantic-equivalence judge**. They cannot detect every paraphrase, wrong attribution, added fact, or incorrect deletion. Inspect `raw`, `text`, and edits for failures; do not equate a proxy pass with general meaning preservation.
- `expected_terms`: dictionary mentions actually present or explicitly authorized for that fixture. Every remaining active dictionary term is a negative control. Positives and negatives replay both without and with the same dictionary, so unwanted coercion is visible.

Metrics separate three questions:

1. `raw_verbatim`: ASR WER against actual spoken reference. Cleanup deletion must not be counted as an ASR improvement.
2. `raw_target` versus `clean_target`: what cleanup changes on the same intended target; both edit counts and reference-token counts are retained, with aggregate **micro-averaged** WER.
3. Dictionary raw/clean TP, FP, FN, precision, recall. Matches are token-bound, case-insensitive and allow possessive `'s`; they do not match arbitrary substrings. No predictions gives null precision, **not** perfect precision. Missed names and negative-control hallucinations remain separate. A phrase such as `Real Reaction` demonstrates preservation of an uncommon proper name, not success on unfamiliar personal names.

WER ignores punctuation/case and normalizes curly apostrophes only. `lexical_exact` and `formatted_exact` are both reported. Dates explicitly accept `twenty fourth`, `24th`, or `24`; the unchanged reference remains `TWENTY FOURTH`. Negations, timing, alternatives and content phrases have independent checks.

## Actual coverage and exposure

| Fixture IDs | Recording and desired distinction |
|---|---|
| `ami-1016`, `ami-8056` | Natural filled pauses; repeated `the`; fragment preservation |
| `ami-1025`, `ami-1037`, `ami-4035` | Repetitions, cutoff, ambiguous repair; code and tomorrow-evening constraints |
| `ami-4006`, `ami-11045` | Abandoned `Some people are` → `I know some balanced people`; `some` → `something` false start |
| `ami-4062`, `ami-10097`, `ami-11072` | Date 24th; third/second alternatives; **would not** negation |
| `ami-1040`, `ami-10014` | Spoken Java's and fictional company Real Reaction; natural name positives |
| `ami-25` | Previously diagnosed `jiggery pokery` bias failure, paired against the other natural absent-term controls |
| `domain-kenan`, `domain-kelana` | Synthetic domain-name positives; generator pronunciation, not natural personal dictation |
| `negative-canon`, `negative-call-anna` | Synthetic ordinary-name/phrase near-neighbor negatives; must not become Kenan/Kelana |
| `replacement-positive`, `replacement-negative` | Synthetic exact phrase replacement and absent-phrase control |

The 12 newly selected natural clips lie beyond the earlier project's first-100 AMI IHM test slice. They were selected by annotation content before this replay and were not used to tune the runtime in this task. This is a **new evaluation selection**, not a guarantee against all project/model training exposure. `ami-25` is expressly **prior-seen diagnostic**, not holdout. Synthetic extras are authored diagnostics, never holdout natural speech. Future engine tuning on these clips makes them regression fixtures, not fresh generalization evidence.

DisfluencySpeech was considered but not copied: it is a human speaker's studio reenactment of Switchboard-style utterances, **not natural spontaneous conversation**; earlier project validation/test splits were also already examined. GigaSpeech's repository license does not establish redistribution rights for all underlying recordings. AMI provides natural speech with explicit CC BY 4.0 permissions instead. See [NOTICES.md](NOTICES.md).

## Live CPU baseline, not candidate-fix evidence

[`baseline/`](baseline/) records **34 sequential realtime sessions** against the selected CPU engine before the parent tail/scored-alternative changes. Seven natural clips and all six synthetic clips were measured in paired dictionary/plain mode; date and known-bias clips additionally have tight/silence variants. Six other committed natural clips remain unmeasured in this baseline. `metadata.json` identifies endpoint, runtime source-file hashes, corpus hash and limits; `summary.json` aggregates receipts by recording kind, dictionary mode and finish condition.

`dictionary_enabled: true/false` records what the client sent. `expectation_pass`, `meaning_proxy_pass`, `lexical_exact`, and `formatted_exact` are **desired-behavior outcomes**, not expected-current-engine labels or evidence that a failure is acceptable. This baseline is intentionally failing and must not be relabelled to make it green.

| Immediate natural baseline (7 clips/mode) | Plain | Dictionary |
|---|---:|---:|
| Raw verbatim WER | 13.10% | 15.48% |
| Raw intended-target WER | 16.88% | 19.48% |
| Clean intended-target WER | 15.58% | 18.18% |
| Desired expectations passed | 2/7 | 2/7 |
| Dictionary TP / FP / FN | 2 / 0 / 1 | 2 / 0 / 1 |

Concrete observations:

- Date `twenty fourth` stops at `twenty` on immediate/tight finish. 400 ms added silence recovers `twenty four` and cleanup formats `24` (bounded date proxy passes).
- `jiggery pokery` becomes `jiggery pocket` without bias and **`jiggery pot greet it` with bias**. Added silence rescues final `work`, not the uncommon phrase. This is a measured dictionary failure, not a fix claim.
- Java's is recognized, but immediate finish drops `tool kit`; Real Reaction and the `would not` negation survive.
- The abandoned-clause clip loses `no I` in raw ASR, yielding `Some people know some balanced people`; cleanup cannot infer the reference meaning reliably from that.
- No active dictionary name was spuriously inserted in this bounded set. That does not establish safe dictionary behavior generally; synthetic positive recall is **0/3**, and synthetic near-neighbor speech itself is poorly recognized. All six synthetic exact-clean expectations fail in both modes.
- Several immediate final roundtrips exceed 100 ms, including first-request 217 ms, date 109 ms, known-bias 198 ms, and synthetic Kenan 399 ms. Appended-silence final waits are under 1 ms on the two measured natural clips, after already spending 400 ms. These are loopback client timings under live CPU conditions, not a broad SLA or accuracy result.

Use the same commands against a candidate engine and compare immutable receipts. Recognition, cleanup and dictionary failures need different remedies. This owner supplies that separation; it claims neither a full rewrite nor overall product accuracy improvement.

## Scored dictionary candidate

[Dictionary evaluation](DICTIONARY.md) owns the subsequent bounded lexical-path
candidate, its natural positive increment and remaining extra-word error, 29 newly
labelled synthetic controls, caught quotation-control failure, repaired final
sentence holdout, immutable receipts and CPU latency. It does not replace or
relabel this earlier baseline, and does not establish broad unfamiliar-name accuracy.
