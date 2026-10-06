# Local learned transcript rewrite — bounded CPU evaluation

**Decision: do not integrate this candidate.** The published Mumble int8 ONNX
is slower and less accurate than deployed Write cleanup on this diagnostic slice.
This directory owns an entirely local, resident experimental adapter and its
reproducible evidence. No pooled or cloud inference, production engine changes,
or automatic fallback are involved. Model/tokenizer downloads are public artifact
retrieval, not transmission of dictation.

## Candidate and provenance

[`model.json`](model.json) pins `adikuma/mumble-cleanup` at
`499e8d060dccf9a8c24383f0cf7e7889dbcc6aa3`, with SHA256s for the
495,938,788-byte int8 ONNX and 11,421,896-byte tokenizer. The publisher explicitly
declares **Apache-2.0**, including the Qwen2.5-0.5B-Instruct base. LoRA r16 was
trained on synthetic single-turn dictation pairs. The card says 688 pairs; the
model report says 612 unique pairs after deduplication. Its quality and CPU latency
tables are still placeholders, so none of its claimed benefits is treated as a
measurement.

Sources read before selection, all at the pinned revision:

- [Model card](https://huggingface.co/adikuma/mumble-cleanup/blob/499e8d060dccf9a8c24383f0cf7e7889dbcc6aa3/README.md)
- [Publisher report](https://huggingface.co/adikuma/mumble-cleanup/blob/499e8d060dccf9a8c24383f0cf7e7889dbcc6aa3/docs/model_report.md)
- [Frozen system prompt](https://huggingface.co/adikuma/mumble-cleanup/blob/499e8d060dccf9a8c24383f0cf7e7889dbcc6aa3/src/cleanup/prompts.py)
- [Chat template](https://huggingface.co/adikuma/mumble-cleanup/blob/499e8d060dccf9a8c24383f0cf7e7889dbcc6aa3/chat_template.jinja)
- [ONNX exporter](https://huggingface.co/adikuma/mumble-cleanup/blob/499e8d060dccf9a8c24383f0cf7e7889dbcc6aa3/src/cleanup/export/to_onnx.py)

The alternative [vamshi0310/finetuned-disfluency-correction](https://huggingface.co/vamshi0310/finetuned-disfluency-correction)
was excluded: neither its model card nor model metadata declares a license, and
the repository listing contains no standalone LICENSE. The T5 base license does
not establish permission for its independently fine-tuned weights.

## Rebuild and run

Cache ownership: this directory's `download.py` and manifest own
`/home/kenan/.cache/pi-write/local-rewrite/mumble-499e8d060dccf9a8c24383f0cf7e7889dbcc6aa3`.
It contains only rebuildable public weights/tokenizer, no personal state. Delete it
to reclaim ~507MB. Weights are never committed. Runtime uses the existing deployed
Write venv; exact measured versions are in each `run-*.json` receipt.

From this directory, each command is foreground and bounded below 55 seconds:

```sh
PY=/srv/pi/write-engine/venv/bin/python
$PY download.py onnx/int8/model.onnx
$PY download.py tokenizer.json
$PY runtime.py 'um i do not want to delete the backups'
$PY evaluate.py freeze
$PY evaluate.py run --start 0 --count 3
$PY evaluate.py run --start 3 --count 3
$PY evaluate.py run --start 6 --count 3
$PY evaluate.py run --start 9 --count 2
$PY evaluate.py summarize
$PY -m unittest test_runtime -q
```

`runtime.LocalRewriter` loads CPUExecutionProvider only, two threads, one resident
session guarded by a lock, empty KV cache per request and incremental cached
greedy decoding. It uses the publisher's exact system prompt and no-tools chat
template. Prompt cap 384 tokens; generation cap 128 tokens, no sampling. Long
prompts/chat control injection are explicit failures, not truncated requests.
`RewriteResult.error` must be checked: generation-limit text is **diagnostic partial
output**, not an accepted cleanup. Initialization failure is loud; there is no
silent substitution of another model. No dictionary/context conditioning has been
added: the fixed publisher prompt provides neither. Authored name controls test
preservation of already correctly spelled names, not acoustic name resolution.

[`REPORT.md`](REPORT.md), [`summary.json`](summary.json), [`results.jsonl`](results.jsonl),
raw [`run-00.json`](run-00.json) and subsequent batch receipts own the result.
[`slice.jsonl`](slice.jsonl) freezes the exact inputs and targets;
[`sources.json`](sources.json) records source corpus hashes. `controls.jsonl`
contains authored controls; only the six named in `evaluate.py` were executed.
