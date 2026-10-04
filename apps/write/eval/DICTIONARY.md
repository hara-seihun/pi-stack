# Dictionary recognition: bounded positive gain, not broad name accuracy

This evaluation compares main `42b3c40f` with the [scored lexical decoder](../engine/DICTIONARY.md), using identical pinned acoustic models and the existing cleanup/tagger/punctuator. Parent integration of the broader local rewrite is **not** part of these measurements.

## Outcome

| Dictionary enabled | Before | Final |
|---|---:|---:|
| Natural AMI, 13 clips: raw/clean TP / FP / FN | 2 / 0 / 1 | 3 / 0 / 0 |
| Natural raw verbatim WER | 11.64% | 10.58% |
| Natural clean intended-target WER | 14.63% | 13.41% |
| Natural desired lexical/format proxies passed | 6/13 | 7/13 |
| Original synthetic 6: clean TP / FP / FN | 1 / 0 / 2 | 1 / 0 / 2 |
| Final untouched synthetic 6: clean TP / FP / FN | 3 / 0 / 0 | 3 / 0 / 0 |
| Final untouched synthetic 6: raw TP / FP / FN | 2 / 0 / 1 | 2 / 0 / 1 |
| Final untouched synthetic 6: formatted exact / structure pass | 6/6 | 6/6 |

**The natural positive increment is on previously seen/tuned AMI25, not a fresh natural holdout.** Before: `jiggery pot greet it`. Final: `jiggery pokery it`. The dictionary phrase is recovered with its own acoustic path rather than a fabricated confidence, but the extra `it` remains. Existing punctuation adds a comma after `jiggery`. This is improved recognition, **not an exact sentence or completed meaning-preserving rewrite**. The lexical meaning proxy accepts that imperfect result; it is not a general semantic judge.

The other twelve natural raw texts are unchanged. Plain/no-dictionary raw and clean texts are unchanged across all nineteen original fixtures. Java and Real Reaction were already recognized; synthetic Kenan and Jodie remain supported. Kelana, Hara, Renia, Seihun, Nebulani and Qwen have unsupported/misrecognized pronunciations in these small synthetic probes. No broad unfamiliar-name accuracy improvement is established. Canon, call Anna, Quinn, tall scale and absent replacement phrases are not forced into dictionary terms in the measured controls.

## Exposure, tuning and the caught failure

1. Original natural/synthetic 19 are exposed regression diagnostics. Completion budgets 3, 4.5 and 6 and bounded search variants were tried on previously diagnosed AMI25. Final width is eight, incomplete reservation two, completed prior six. Earlier +3-per-token bias was not simply increased: incomplete credit is refunded and total completed phrase credit is bounded.
2. `dictionary-controls.json` declares four new tuning sentences and eight initially held-out sentences before recognition. They were consulted during development and **are now exposed regression controls**, not final heldout evidence. No positive increment was seen on them; missed starts were left missed.
3. `dictionary-heldout.json` declares eleven further sentences after the first runtime freeze. The first candidate lost `close quote` after Jodie. Its failing receipts are retained. A 55-second interrupted foreground replay left **11 plain and 10 dictionary sessions**; the dictionary `fresh-call-anna` counterpart was not measured in that first candidate. No missing result is counted as a pass. Quote repair is a separate paired diagnostic.
4. The root repair restricts blank timing branches to **incomplete** lexical prefixes. Completed names return to greedy timing; the unit regression requires the following `close` token on every surviving path.
5. After that repair, `dictionary-final-heldout.json` declares six new sentences, including quoted negation/numbers, Canon/call Anna negatives and exact replacement/absent-source controls. Runtime settings/code were not tuned after observing these six. All six dictionary outputs are formatted exact, quotation balanced, and preserve protected literal content. They use already tested Kenan/Jodie names and the same eSpeak voice: this is **held-out sentence/control evidence**, not unseen pronunciation, speaker or natural-name generalization.

All added audio is explicitly **eSpeak NG 1.52.0, en-gb, 155 words/minute**, CC0. No household recording was used. References are synthesis inputs; desired clean targets are authored. See [provenance](NOTICES.md).

## Latency and limits

CPU, four ORT encoder threads, 40 ms input chunks, burst execution, 600 ms model padding, no concurrent streams within this evaluator. Model initialization is excluded from per-session timings. Other work on the host was not controlled, so these are not randomized speed comparisons or an end-to-end WebSocket/phone SLA.

| Dictionary-enabled natural 13, milliseconds | Before | Final |
|---|---:|---:|
| Median total recognition + existing cleanup | 1721 | 1937 |
| Median decoder Finish | 217 | 234 |
| Median full Finish | 234 | 250 |
| Maximum full Finish | 258 | 438 |
| Median real-time factor | 0.336 | 0.383 |

Final synthetic six: median full Finish 283 ms, maximum 344 ms. These immediate Finish cases **do not meet 100 ms**. Added beam work is real; do not claim a dictionary speedup from the lower median total time in one synthetic batch. Rewrite latency is additional and owned by the parent integration.

## Reproduce and inspect

Receipts, including failures and developmental sweeps: [`dictionary-results/`](dictionary-results/). `summary.json` selects the before/final original corpus, failed first holdout, quote repair and final heldout measurements. Every final receipt records all three runtime-file hashes, pinned model identity, source audio hash, raw/clean text, measured joiner word support, edit counts, dictionary TP/FP/FN and timing. The acoustic source has not changed between paired runs.

```sh
PY=/srv/pi/write-engine/venv/bin/python
$PY apps/write/eval/dictionary_controls.py --check
$PY apps/write/eval/dictionary_controls.py --fresh-heldout --check
$PY apps/write/eval/dictionary_controls.py --final-heldout --check
$PY -m unittest discover -s apps/write/eval -q

# Keep attended batches small. Output appends; use a fresh path or unique slice.
$PY apps/write/eval/dictionary_local.py --limit 3 --output /tmp/dictionary-final.jsonl --label candidate
$PY apps/write/eval/dictionary_local.py --offset 3 --limit 3 --output /tmp/dictionary-final.jsonl --label candidate
# A missing half-pair can be resumed with --id ID --dictionary on|off.

# Read immutable receipts; no model call.
$PY apps/write/eval/dictionary_summary.py
```

For a clean before replay, extract `apps/write/engine/nemotron.py` from `42b3c40f` into a temporary source file and pass `--recognizer-source PATH`. It uses the evaluator's same pinned encoder/joiner and existing cleanup. To reproduce final-heldout audio, pass `--manifest apps/write/eval/dictionary-final-heldout.json` with bounded `--offset`/`--limit` slices.

Runtime commits have not been published/deployed by this worker. The parent owns combined rewrite/recognition integration and both-host publication. These measurements do not substitute for that deployed end-to-end proof.
