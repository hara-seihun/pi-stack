# External meeting recognition

This component recognizes durably queued external meeting audio for [Meet](../remote/docs/meet.md). Platform-provided transcripts bypass it; conversational Voice uses its own provider.

The host-owned `pi-stack-meet-recognition.service` keeps the pinned English Nemotron ONNX INT8 CPU model resident independently of per-person supervisors. Each connection owns one raw recognition stream. No text cleanup or rewriting is applied. The service does not store audio or transcripts: the person's encrypted `MeetTranscriptStore` owns the queue, transcript and failed-audio retry.

## Wire and lifetime

The loopback listener is `ws://127.0.0.1:8797/`. Ordinary supervisors use their UID-gated model broker's `/v1/meet/recognition`; administrator supervisors use the loopback listener directly. The engine port stays off the LAN and remains UID-gated by host configuration.

One connection accepts:

1. `{"type":"start","turn":"MEETING_TURN_ID"}`
2. Binary 16 kHz mono little-endian signed PCM16, even-length frames, at most 512,000 bytes (16 seconds) per turn.
3. `{"type":"finish"}` or `{"type":"cancel"}`.

Every audio chunk returns `{"type":"partial","text":"RAW_TEXT"}`, including silence. Finish drains the recognizer with 600 ms right-context silence and returns `{"type":"final","text":"RAW_TEXT"}`. Invalid sequences, oversized audio and recognition failures return `{"type":"error","message":"..."}`. Connections have a 60-second lifetime and four bounded decoder slots. Cancellation waits for an already-running native step before returning its slot. Disconnect retires the stream; failed queued audio remains in the person's store.

## Deployment

Install the reference [unit](../../deploy/systemd/pi-stack-meet-recognition.service) through the host's configuration owner. [`deploy/meet-recognition`](../../deploy/meet-recognition) prepares the hash-locked Python environment, SHA-pinned model and CPU conversion under `/srv/pi/.pi-meet-recognition` without activating services. `deploy/prepare` invokes it only on hosts declaring the unit. `deploy/host` selects its prepared runtime at `/srv/pi/meet-recognition` and activates it through `deploy/meet-recognition-service`.

Environment/dependency keys and weight keys are independent: source or dependency changes do not refetch weights. Public Python installs copy package files rather than sharing private installer-cache inodes. After acceptance, retention keeps selected/previous runtimes, linked environments/weights and entries still referenced by live processes. It never touches personal records.

`PI_STACK_MEET_RECOGNITION_DEST` selects the runtime path and `PI_STACK_MEET_RECOGNITION_URL` the endpoint. `PI_STACK_MEET_RECOGNITION_FORCE=1` permits preparation without a host unit for a rehearsal. Selection requires an already-prepared immutable tree.

## Focused checks

Protocol tests need only Python:

```sh
python3 -B -m unittest discover -s apps/meet-recognition -p test_protocol.py
```

With the prepared environment and model:

```sh
PI_STACK_TEST_MEET_RECOGNITION_MODEL=/srv/pi/meet-recognition/model \
  /srv/pi/meet-recognition/venv/bin/python -B -m unittest discover -s apps/meet-recognition
```

The two licensed public AMI clips test immediate-finish terminal-word retention. [Fixture provenance](fixtures/README.md) owns their attribution and source identities.
