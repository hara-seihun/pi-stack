# Write cleanup

`clean(words, dictionary, context) -> {text, edits}` accepts committed ASR words (`w`, nullable `conf`, `alts` as strings or `{w,conf}` objects). `IncrementalCleaner(dictionary, context).update(newly_committed_words)` and `.finish(final_tail)` share this contract; create one session per dictation. Edits use half-open indices into the full source word stream, including deleted words.

A single bounded source-constrained pass handles fillers, direct repetition, explicit self-repair markers, dictionary replacements, low-confidence dictionary alternatives, two-word cardinal numbers, spoken formatting commands, casing and final punctuation. It has no language model or shared mutable state. Explicit `new line`, `new paragraph`, `bullet point`, `comma`, `period`, `colon`, `question mark` and `exclamation mark` are formatting commands. Content words otherwise come from the transcript or explicitly configured dictionary. A replacement rule has precedence over generic casing.

A session revisits its unfinished sentence on each update; completed source sentences outside the 12-word lookbehind are finalized. Partials can change, while `finish` only receives and processes the final tail plus unfinished sentence. Treat ASR timestamps and confidence as supplementary; a recognizer returning `conf=None, alts=[]` is supported. The product does not instantiate or reload a model per dictation.

A measured five-branch resident Qwen3-0.6B GGUF edit-lattice scorer did not improve on this pass: held-out DisfluencySpeech token errors rose from 977 to 988/5,228, with p95 full-utterance scoring 113 ms and p95 3–8-word-tail scoring 63 ms when four punctuation branches were active. It is not installed on the product path; the experiment's C++/Python sources and reproducible receipts live under `/home/kenan/work/pi-stack-write/cleanup/scorer_probe/`. This result does not exclude a shared-prefix KV implementation with better proposals.

Evaluation data, benchmark script and measured limitations are in `/home/kenan/work/pi-stack-write/cleanup/REPORT.md`. Run the contract regressions from the Pi Stack root with `python -m unittest apps.write.engine.cleanup.test_cleanup -q`.
