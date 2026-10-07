# Native resource ownership

These are source contracts, not measured CPU, battery or energy savings. Controlled device profiling remains necessary. Unit checks do not prove hardware microphone batching, screenshot encoding latency or screen-off behavior.

## Shared overlay and accessibility

`SharedOverlay` owns the single dot and an 80 ms event reconciliation window across both accessibility services. It cancels pending reconciliation when both services detach. Window-type snapshots filter accessibility-overlay and IME focus/content events; topology and configuration changes still reconcile geometry. Ordinary text-only content events do not trigger focus scans. Authentication, overlay and microphone eligibility, and the required keyboard gate precede Write focus discovery. A still-focused valid target is reused before searching application roots.

`KenanOverlay` caches available display/keyboard bounds between geometry events and invalidates dot/scene only for changed visual state or geometry. Idle Kenan is static. Actual thinking/working, gestures and finite highlights remain animated; Write connecting/finalizing pulses remain animated. Recording waveform redraws follow changed amplitude/backlog rather than a second continuous waveform timer. Disconnect settles Kenan to idle even after all message acknowledgements have removed pending sends. This does not cancel an independent active Write attempt.

Write learning keeps its inserted text/node/identity only for the 20-second monotonic learning window. Completion schedules explicit reference expiry without requiring another event; a submitted correction, a new recording, identity replacement, interruption and teardown clear it earlier. Live editor targets and deliberate field dismissal remain separately owned.

## Microphone capture

`WriteOpusRecorder` reads Android PCM in blocking mode. Cancellation calls `AudioRecord.stop()` to unblock capture immediately. Finish keeps its existing 200 ms tail and uses a one-shot stop timer to unblock a pending read at the deadline, then pads a partial frame and flushes Opus EOS. The timer retires with the recording. Inputs that explicitly return empty data wait one audio frame (20 ms), not 5 ms. The packet sender waits for producer notifications instead of waking every 80 ms while its queue is empty. Existing bounded audio/packet and transport-backpressure checks remain.

## Replay acceptance

`PhoneCommandReplay` owns a process-wide ordered persistence executor, shared across overlapping foreground-service lifetimes. Before dispatch, it reads the durable ledger, rejects duplicate acceptance, appends the command identity and synchronously commits on its worker. It retains at most 512 identities and queues at most 512 acceptance operations. The receipts are `PERSISTED`, `DUPLICATE`, `STATE_ERROR` or `BUSY`; only persisted acceptance may dispatch. No argument bodies enter the ledger. Corrupt history and failed commits never become empty successful history.

`PhoneControlService` reserves identities on main for in-flight duplicate rejection, then consumes the persistence receipt on main. Connection, identity and deadline are checked again before UI or data mutation. Rejected queue admission returns `rate_limited`; duplicate acceptance returns `unconfirmed`. Service teardown does not kill or replace the process-wide actor, preventing old snapshots from overwriting newer acceptance. There is no idle persistence timer.

## Screenshots

`PhoneAccessibilityService` permits one in-flight capture/encode per service lifetime. Screenshot callbacks hand the hardware buffer to a service-owned worker; software copy, PNG compression and base64 encoding run there, not on main. Teardown closes admission and lets the bounded outstanding task retire. Buffers/bitmaps are closed or recycled on every encoding outcome. Capture rechecks command authorization, accessibility-service/overlay generation and deadline before encoding, before base64 conversion and before main-thread delivery. Completion restores capture visibility on main.

Capture rejects images exceeding 16 million pixels before a software copy, and `BoundedImageBytes` limits PNG storage/capacity to 10 MiB while Android streams encoder output. Excess bytes are discarded and yield `too_large`, never a truncated successful image. These bounds limit allocations; they do not promise a fixed encoding latency or successful allocation on every device.

## Focused checks

From `apps/kenan/android` after the ordinary generated Capacitor sync:

```sh
./gradlew testDebugUnitTest --tests '*KenanOverlayTest' --tests '*WriteAccessibilityServiceTest' --tests '*WriteOpusRecorderTest' --tests '*PhoneAccessibilityServiceTest' --tests '*BoundedImageBytesTest' --tests '*PhoneCommandReplayTest' --tests '*PhoneReplayAcceptanceTest'
```

Tests cover static idle versus active animation, unchanged geometry/visual refresh, acknowledged-busy disconnect, eligibility gates, coalesced event bursts, IME/self-event filtering, explicit learning expiry, blocking-read finish/cancel, tail/Opus ordering, bounded encoder bytes, persistence-before-mutation, identity fences, racing replay owners, corrupt/failed persistence and admission overload. They run without manipulating the person's phone or deploying an APK.
