# Write streaming engine

`server.py` owns resident recognition, incremental cleanup and final local rewrite;
`deploy/write-engine` installs the engine, Python environment, and pinned models. Android's `WriteOpusRecorder` owns
capture and Opus encoding, `WriteConnection` owns the phone protocol, and Pi Remote
and the orchestrator forward frames in order. See [GPU behavior](GPU_REPORT.md) and
[cleanup](cleanup/README.md) for those components. [Final rewrite](REWRITE.md)
owns the resident CPU Qwen3-4B-Instruct-2507 path, guards, limits and reproduction;
[runtime installation](../rewrite-runtime/README.md) owns its pinned artifacts.
[Audio evaluation](../eval/README.md) owns the licensed fixtures and replay tool;
[local rewrite evaluation](../local-rewrite/README.md) owns the separate rejected
Mumble candidate and reproducible scores. Qwen prompt tuning and final measurements
are underway; this source description is not a deployment or corpus-success claim.

## Dictionary support

ASR words include `w`, `conf`, and scored `alts: [{w, conf}]`. Scores are the
geometric mean of original (unbiased) joiner softmax support over that word's
pieces. An alternative replaces one piece's score with that piece's own support;
it is not assigned the primary word's score. Alternatives are ranked by support
and cannot cross a word boundary. These local scores are not calibrated
probabilities of word correctness or a fully decoded alternative lattice.
[Bounded lexical search](DICTIONARY.md) now scores complete dictionary paths
with refunded incomplete-prefix credit, independent of canonical BPE segmentation.
Words and explicit replacement source phrases provide recognition context;
replacement execution remains the person's authority. Automatic cleanup substitution requires a
low-confidence primary, a dictionary-listed alternative and measured support
within .12 of the primary. Unscored alternatives cannot trigger it.
[Measured before/after results](../eval/DICTIONARY.md) include the natural phrase
gain, caught quotation-control regression and limits of the synthetic name controls.

```sh
/srv/pi/write-engine/venv/bin/python -m unittest test_dictionary_decoder test_dictionary_scores -v
```

Partials use the learned deletion tagger, source-constrained rules and resident
punctuation. Finish then runs the entirely local resident generative editor on the
dictionary-normalized recognized text. Guarded or unavailable rewrite retains the
cleaned baseline with an explicit client notice, not silent degradation. Earlier
Qwen3-0.6B and Mumble failures are separate experiments, not evidence for this
candidate. Meaning preservation and unwanted dictionary substitutions must be
scored alongside fluency; lexical guards alone are not a semantic guarantee.

## End of speech is an ordered boundary

One socket carries `start`, binary audio frames, then exactly one `finish` or
`cancel`. Start declares `audio: "opus"` (raw Opus packets) or `"pcm"` (16 kHz mono
signed little-endian PCM16). `finish` follows every audio packet, including encoder
EOS output; the connection remains open for the engine's `final` response.

Android Finish requests a bounded 200 ms capture tail instead of immediately
calling `AudioRecord.stop()`, which discards unread PCM. The capture worker polls
nonblocking reads, then stops the microphone, zero-pads its partial 20 ms frame,
and drains MediaCodec through EOS before reporting `stopped`. The service drains
its packet queue before sending wire `finish`. Cancellation calls the separate
recorder `cancel()` to stop capture immediately without waiting for the tail or
flushing discarded audio. Neither path waits for microphone data on the UI thread.

The engine keeps pending samples until an encoder slot has been acquired. Finish
cancels and joins the decoder tasks, awaits any already-running live model step,
then consumes all pending samples before adding 600 ms of recognizer silence.
This is model right context, not an extra microphone wait. Real AMI terminal words
`fourth` and `toolkit` still disappeared at 200 ms; 400 ms left `four`/`tool`, while
600 ms completed both. On the local two-thread CPU probe this cost about 280 ms
when no speculative final was ready: completeness takes precedence over the
100 ms flush target, which is not met by that immediate-Finish case.
These recognition-only timings exclude the new final rewrite. Finish with rewrite
is seconds-scale, not the 100 ms recognition flush target; native Android waits up
to 30 seconds after sending Finish. `timing.flushMs` includes rewrite, while
`rewrite.latencyMs` isolates its queue/inference time. Final latency measurements
are still underway.

Immediate and speculative finalization use the same right context. A speculative
result is reusable only when its sample count exactly matches the received PCM;
quiet speech after that boundary cannot be discarded by the RMS silence detector.
The CPU-shadow path follows the same ownership rules. Cancel does not wait for an
encoder slot or produce final text; an already-running model call may complete in
its isolated stream after cancellation.

## Focused regression proof

From this directory, with the deployed engine's Python environment:

```sh
/srv/pi/write-engine/venv/bin/python -m unittest test_finishing test_opus test_dictionary_scores -v
PI_STACK_TEST_WRITE_MODEL=/srv/pi/write-engine/model OPENBLAS_NUM_THREADS=1 \
  /srv/pi/write-engine/venv/bin/python -m unittest test_audio_tail -v
```

`test_finishing.py` covers Finish during encoder-slot contention on both paths,
a quiet terminal word after speculation, and cancellation while an encoder is busy.
`test_opus.py` covers real packet decoding, socket framing, batching and backend
races. `test_audio_tail.py` uses the licensed AMI date/tool-name fixtures against
pinned weights to require complete terminal words after immediate Finish. Phone-side `WriteOpusRecorderTest` covers delayed tail delivery, partial-frame
padding, EOS packets before the terminal callback and immediate cancellation;
`WriteConnectionTest` covers tail-packet/finish ordering and one-shot finish.

These tests do not exercise a physical Android microphone or vendor MediaCodec.
The 200 ms capture allowance and native EOS behavior need a device-level immediate-
Finish check; samples not delivered by the hardware within that allowance are not
recoverable by the server. Recognition accuracy is not guaranteed by sample custody.
