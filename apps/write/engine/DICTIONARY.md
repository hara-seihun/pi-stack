# Local scored dictionary recognition

`dictionary.py` owns lexical context; `dictionary_decoder.py` owns bounded contextual RNN-T paths. `nemotron.py` connects them to the same pinned CPU/GPU encoder and joint network. Nothing here calls a hosted model, phonetic service or network. [Measurements and remaining failures](../eval/DICTIONARY.md) separate recognition from cleanup.

## Search contract

An empty dictionary keeps the existing greedy decoder unchanged. A nonempty dictionary supplies its word spellings and explicitly authorized replacement **source** phrases as context; replacements themselves remain cleanup's responsibility.

- Match decoded characters case-insensitively at word boundaries, not the tokenizer's one canonical token segmentation. Both `p+ok+ery` and `po+ke+ry` can represent `pokery`.
- Keep at most eight paths. Initial word-start alternatives must be within **2 log-score units** of the primary joiner token; continuation alternatives must be within **4**. An acoustic zero is not repaired by inventing a pronunciation.
- Reserve **2** log-score units for an incomplete prefix with at least two recognized letters. Refund that reservation on divergence. A complete phrase earns **6** units, once, confirmed at the following boundary. Overlapping dictionary spellings do not multiply the completion reward. This is a whole-phrase prior, not another +3 for every subword.
- Ordinary speech keeps greedy emission timing. Only an incomplete lexical continuation can branch on blank. A completed name must not delete subsequent ordinary words, numbers, negations or spoken quotation controls.
- Each path owns its predictor history and acoustic scores. Merge token-identical alignments with log-add-exp; rank using acoustic score plus the lexical prior. Report selected token softmax support **before** that prior. The word's geometric support and local one-piece alternatives are not calibrated correctness probabilities or full phrase posteriors.
- Expose only the common token prefix while paths compete. Resolve a branch after bounded word-level right context; Finish selects the winning remaining path. The server's already committed words cannot change. Forked finalization shares immutable hypothesis state, not a mutable encoder/predictor cache.

Lexical matching retains only a longest-phrase-sized suffix and a scalar confirmed reward. It does not rescan the entire utterance to recompute dictionary matches. Candidate/potential caches are per dictionary, bounded to 256 suffixes.

Names' requested casing and exact replacements are restored by cleanup, not by changing joint probabilities. This component does not infer missing names, delete an unwanted `it`, or claim that synthetic pronunciation represents the household's speech.

## Focused proof

```sh
cd apps/write/engine
/srv/pi/write-engine/venv/bin/python -m unittest test_dictionary_decoder test_dictionary_scores -v
```

Fourteen tests cover alternative support, segmentation/case independence, refunded prefix bonuses, single completion credit, replacement-source context, immutable forks, common-prefix streaming commitment, and preservation of a quotation control after a name. Public-audio replay also checks the server's stable-before-last-two-words contract at every 40 ms input step.
