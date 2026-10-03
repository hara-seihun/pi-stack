# Local rewrite measurements

These receipts evaluate the pinned Qwen3-4B-Instruct-2507 Q4_K_M CPU runtime, not Mumble and not a cloud model. [Implementation/limits](../REWRITE.md) and [dictionary acoustic evaluation](../../eval/DICTIONARY.md) own the two different stages. Source/model hashes accompany final text, recorded-ASR and live-WebSocket receipts. Baseline uses the deployed pinned deletion tagger and punctuation model. All inputs are authored controls or licensed public AMI audio; no private dictation was copied.

## Final authored text controls

`rewrite-final-all.jsonl` contains 20 bounded lexical-content controls: **12/20 baseline passes, 20/20 returned-output passes**. Of the latter, 15 apply rewriting, four are unchanged, and one is explicitly guarded baseline retention. WER against authored targets is **52 → 7 errors / 235 reference tokens**. Median warmed inference is **1,290 ms**, maximum **2,767 ms**, excluding startup/shared-prefix warmup. Lexical content checks are not a semantic-equivalence judge.

| Selection | Baseline / returned passes | Baseline → returned token errors |
|---|---:|---:|
| Development 4 | 2 / 4 | 11 → 0 / 37 |
| Exposed diagnostic 8 | 6 / 8 | 21 → 0 / 79 |
| Previously consulted regression 4 | 2 / 4 | 13 → 7 / 55 |
| Post-initial-prompt-freeze controls 4 | 2 / 4 | 7 → 0 / 64 |

The last four retain historical `final-holdout` labels: they were declared after the initial prompt freeze. Subsequent present-dictionary-term prompting was added for exposed AMI25, and formatting guards were extended; all 20 were then replayed. **Do not call these final untouched holdout results.** No setting was selected using the last four's outcomes. The acoustic decoder's separate final sentence holdout is documented independently.

Remaining awkward phrasing is visible: the alert example retains `The reason I meant was that...`. A candidate also erased `I think` in the sign-up example; the uncertainty guard rejects it and returns the baseline. Counting that returned-output pass is not evidence that the model itself preserved meaning.

## Editing actual recorded ASR

`natural-asr-editing.jsonl` edits dictionary-enabled recognition receipts from all **13 natural AMI clips** in `dictionary-results/final-safe-corpus.jsonl`. It does **not** run fresh recognition or measure microphone/transport timing. The original raw/word/acoustic identities are retained, and the new baseline is recomputed with canonical casing and atomic dictionary punctuation.

- Desired final expectations: **7/13 before and after**. Bounded meaning proxies: **10/13 before and after**.
- Clean target WER: **22 → 27 errors / 164 words (13.41% → 16.46%)**. No natural-speech accuracy improvement is claimed for the generative stage. Contraction (`we are` → `we're`), reordering `third or second` and removing an abandoned transcription clause contribute to this mismatch; that does not establish universal meaning preservation either.
- Three guarded outputs retain baseline because of quotation, numeric-format or uncertainty differences. Ten outputs are accepted/unchanged.
- Median warmed editor time **1,114 ms**, maximum **2,158 ms**. ASR/init/transport time is excluded.
- Raw `Some people know some balanced people` has already lost the repair intention; rewriting does not recover it. AMI25 retains the extra recognized `it`, even though its dictionary phrase now survives.

Reproduce with the prepared runtime and model:

```sh
PY=/srv/pi/write-engine/venv/bin/python
$PY apps/write/engine/benchmark_rewrite_audio.py \
  --binary /srv/pi/write-engine/rewrite-runtime/llama-server \
  --model /srv/pi/write-engine/rewrite-model/model.gguf \
  --receipts apps/write/eval/dictionary-results/final-safe-corpus.jsonl \
  --output /tmp/write-natural-editing.jsonl
```

## Live complete pipeline

`final-audio.jsonl` and `integrated-dictionary.jsonl` run real PCM through the combined recognizer, cleaner and local editor over loopback WebSocket. Conditions: one stream, 20 ms realtime packets, two ASR threads, four rewrite threads, immediate Finish, 600 ms recognizer right context, no appended silence. `audio.metadata.json` records implementation/corpus hashes. These are exposed regression checks, not fresh heldout speech or installed-phone tests.

- Synthetic color repair: **“I want the red one; it would be better.”** Both final intention and comparison survive.
- Synthetic garbled lead-in: **“The menu has too many buttons and needs a simpler layout.”**
- Natural negation/uncertainty: retained exactly through an explicit guard.
- AMI25 paired: without dictionary, rewrite says `jiggle around` and fails the desired phrase. With dictionary it retains **`jiggery pokery it around`**; the extra `it` remains. Atomic dictionary punctuation prevents an internal comma. This is a phrase improvement, not an exact sentence fix.
- Quoted Jodie and negative Canon controls retain exact quoted negation/number words through explicit guard decisions; Canon does not become Kenan.
- Client Finish waits across these seven sessions: **1,153–2,239 ms**, not the recognition-only 100 ms objective.

`rewrite-v2-audio.jsonl` retains the earlier failure: lost `better`, retained rambling scaffolding and omitted meaningful `I think`. `rewrite-v3-audio.jsonl` is the intermediate repair, before final present-term prompting/formatting protections. Neither is relabelled as final candidate evidence.

## Converge cold-start repair

Publication reached Converge but startup repeatedly failed: full static-prefix priming
shared the normal 18-second inference timeout. A 40-second foreground budget still
failed under co-tenant load; it was not a permission or model-download failure.
The repaired constructor starts owned one-token prefix priming in the background,
keeps recognition available, and reports explicit `unavailable/warming` rather
than waiting on its lock. Warm failure is explicit, not readiness. Ordinary
request timeout remains 18 seconds; background priming is bounded at 120 seconds.

`converge-bootstrap.json` is a public-only direct CPU probe using the service's
Nice=-10 priority, four generation/eight batch threads, and the pinned model/runtime.
Constructor returns in **2.81 seconds**, prefix priming then completes in
**28.89 seconds**, and the first warmed repair returns **“Send it Thursday.”** in
**1,222 ms**. The initial baseline with `warming` is retained as a distinct outcome.
Child and warm thread are both closed. This proves the repaired runtime on the
actual host, not deployment acceptance or a phone roundtrip. Earlier generation/
punctuation measurements above used four batch threads; their identities and
results are unchanged rather than relabelled.

Deployment now prepares without selecting/collecting Write, warms alongside
independent release work, and rolls back Write selection/service state on failed
or interrupted activation. Acceptance owns retention of selected, prior and live
mapped dependencies. These changes prevent a rejected release leaving a restart
loop or deleting the prior engine before rollback. See the deployment owner.

Runtime smoke checks also reject unauthenticated generation with HTTP 401, reap the child on close and remove its private key directory. Fast tests cover failed launch cleanup and that only dictionary terms already present are passed to the editor. No installed-device/hardware claim follows from these checks. Publication owns both-host deployment and terminal reporting.
