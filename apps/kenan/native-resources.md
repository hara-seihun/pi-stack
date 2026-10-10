# Native resource ownership

## Mandatory admission

`PermissionSetup` owns the required ordinary grants and the closed `complete` / `needs-permissions` state. `SetupGate` owns its scrollable shared native shell, serialized Android Activity Result launchers and return-driven advancement. Missing grants hide the client and its accessibility subtree, suspend native foreground-feed ownership and fence phone commands. Native bootstrap waits for completion. Resume/focus reconciles effective grants; teardown unregisters launchers and releases queued bootstrap callbacks. No saved completion bit can override revoked access.

Device Owner and secure-settings provisioning remain separate capabilities. Declining a grant or stopping the flow stays in setup; retry reads actual Android state. Phone enablement is owner-bound consent independent of setup and transport connectivity.

## Overlay chat and phone-action visuals

`SharedOverlay` registers the phone accessibility service independently of overlay chat. The persistent `overlayVisible` choice owns the chat scope: enabling creates one `KenanOverlay`; disabling removes the chat windows, clears its draft/transcript/receipt references, cancels its handlers and animation callbacks, releases touch/back listeners, and cancels pending geometry reconciliation. Disabled accessibility/configuration events do not schedule overlay reconciliation. A late reply, acknowledgement, gesture completion or queued panel callback cannot revive a closed scope. Explicit re-enablement creates a fresh scope; ordinary thread history remains in the canonical managing conversation.

`NativeShells` supplies the shared palette, card, button and conversation controls used by the overlay and mandatory setup. `KenanOverlay` owns only overlay geometry, gesture drawing and window/receipt lifetimes. Empty conversation history collapses instead of leaving blank panel space.

Enabled chat coalesces geometry events over 80 ms. Window-type snapshots filter accessibility-overlay and IME events. Bounds are cached between geometry changes. Idle Kenan is static; actual thinking/working and finite gesture/highlight effects animate.

Phone control has its own enable choice, connection, heartbeat, command grants and replay ledger. Disabling chat changes none of them. Its capabilities advertise `overlayEnabled`, distinct from `overlay` (Android's display grant), and announce changes through the existing hello frame. Overlay chat uses the existing `overlay.message` protocol; there is no second logging transport.

Authorized phone taps, swipes and edits retain action visualization when chat is disabled. Each action uses a finite, untouchable visualization scope with no composer, transcript, message receipts or return-home timer. Its windows and callbacks retire after the gesture/highlight lease. This is work caused by the separately enabled phone command, not an idle hidden chat. Enabling chat retires that transient scope before constructing the single chat dot. Disabling chat or replacing its scope does not cancel a phone mutation. Authorization, service identity and command deadlines fence the mutation independently.

Screenshot suspension belongs to phone control, not one chat generation. Existing and newly enabled windows stay hidden until outstanding capture suspension is released. Teardown closes both chat and action scopes; stale capture completions cannot affect a replacement service.

## Replay acceptance

`PhoneCommandReplay` owns a process-wide ordered persistence executor, shared across overlapping foreground-service lifetimes. Before dispatch, it reads the durable ledger, rejects duplicate acceptance, appends the command identity and synchronously commits on its worker. It retains at most 512 identities and queues at most 512 acceptance operations. The receipts are `PERSISTED`, `DUPLICATE`, `STATE_ERROR` or `BUSY`; only persisted acceptance may dispatch. No argument bodies enter the ledger. Corrupt history and failed commits never become empty successful history.

`PhoneControlService` reserves identities on main for in-flight duplicate rejection, then consumes the persistence receipt on main. Connection, identity and deadline are checked again before UI or data mutation. Rejected queue admission returns `rate_limited`; duplicate acceptance returns `unconfirmed`. Service teardown does not kill or replace the process-wide actor, preventing old snapshots from overwriting newer acceptance. There is no idle persistence timer.

## Screenshots

`PhoneAccessibilityService` permits one in-flight capture/encode per service lifetime. Screenshot callbacks hand the hardware buffer to a service-owned worker; software copy, PNG compression and base64 encoding run there, not on main. Teardown closes admission and lets the bounded outstanding task retire. Buffers/bitmaps are closed or recycled on every encoding outcome. Capture rechecks command authorization, accessibility-service identity and deadline before encoding, before base64 conversion and before main-thread delivery. Completion restores capture visibility on main.

Capture rejects images exceeding 16 million pixels before a software copy, and `BoundedImageBytes` limits PNG storage/capacity to 10 MiB while Android streams encoder output. Excess bytes are discarded and yield `too_large`, never a truncated successful image.

## Focused checks

From `apps/kenan/android` after generated Capacitor sync:

```sh
./gradlew testDebugUnitTest --tests '*KenanOverlayTest' --tests '*OverlayPositionTest' --tests '*PhoneAccessibilityServiceTest' --tests '*BoundedImageBytesTest' --tests '*PhoneCommandReplayTest' --tests '*PhoneReplayAcceptanceTest'
```

The lifecycle checks advance a virtual clock rather than sleeping. They cover disabled receipt/reconciliation cleanup, late-callback fences, one fresh scope on re-enable, finite action visuals, screenshot suspension across enablement, static idle versus active animation, unchanged geometry refresh, window-failure cleanup, bounded screenshot bytes and persistence-before-mutation. They do not manipulate the person's phone or deploy an APK.
