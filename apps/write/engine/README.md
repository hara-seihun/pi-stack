# Write streaming engine

`server.py` owns resident recognition and cleanup; `deploy/write-engine` installs the
engine, Python environment, and pinned models. Android's `WriteOpusRecorder` owns
capture and Opus encoding, `WriteConnection` owns the phone protocol, and Pi Remote
and the orchestrator forward frames in order. See [GPU behavior](GPU_REPORT.md) and
[cleanup](cleanup/README.md) for those components.

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
then consumes all pending samples before adding 200 ms of recognizer silence.
Immediate and speculative finalization use the same right context. A speculative
result is reusable only when its sample count exactly matches the received PCM;
quiet speech after that boundary cannot be discarded by the RMS silence detector.
The CPU-shadow path follows the same ownership rules. Cancel does not wait for an
encoder slot or produce final text; an already-running model call may complete in
its isolated stream after cancellation.

## Focused regression proof

From this directory, with the deployed engine's Python environment:

```sh
/srv/pi/write-engine/venv/bin/python -m unittest test_finishing test_opus -v
```

`test_finishing.py` covers Finish during encoder-slot contention on both paths,
a quiet terminal word after speculation, and cancellation while an encoder is busy.
`test_opus.py` covers real packet decoding, socket framing, batching and backend
races. Phone-side `WriteOpusRecorderTest` covers delayed tail delivery, partial-frame
padding, EOS packets before the terminal callback and immediate cancellation;
`WriteConnectionTest` covers tail-packet/finish ordering and one-shot finish.

These tests do not exercise a physical Android microphone or vendor MediaCodec.
The 200 ms capture allowance and native EOS behavior need a device-level immediate-
Finish check; samples not delivered by the hardware within that allowance are not
recoverable by the server. Recognition accuracy is not guaranteed by sample custody.
