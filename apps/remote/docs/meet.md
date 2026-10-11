# External meeting participation

Pi Stack joins meetings hosted by external platforms. The standalone ESM `meet-adapter.js` supplies a Liminal-logo camera, conversational OpenAI Live audio, requested shared-browser streams, agent delegation and transcript delivery. The platform integration owns attendance, credentials and transport authorization. Human chat rooms use the separate [room service](rooms.md).

## Adapter and presentation

[`startMeetAdapter`](../web/src/meet/adapter.ts) accepts `{request, namespace, eventKey, name?, container}`. Its injected `(path, init) => Promise<Response>` transport preserves HTTP status, headers, binary bodies and cancellation. It returns camera/browser streams, state, mute, sharing, suspend, close and transcription-recovery controls. The normal build emits `web/dist/meet-adapter.js`, embedding the logo and worklets without sibling asset dependencies.

Every external participant sees **only the Liminal logo** on Kenan's camera. [`media.ts`](../web/src/meet/media.ts) draws the v26 white lockup on Slate `#181822`, never thread state, tools, progress or work. The canonical artwork is `web/public/liminal-logo.svg`, taken from Converge's `products/kenan/src/meeting-agent/liminal-logo.ts` / brand kit `logos/v26-current/liminal-lockup-white.svg`; duplicate identical icon paths are collapsed.

A screen is shared only after an explicit request, and is always the meeting's isolated shared browser. The adapter's explicit `shareBrowser` control and `meet_share_screen` send `{requested:true,url?,watch?}`. The server rejects a missing sharing request. `stopSharing` / `meet_stop_sharing` close Chromium and its watcher. Work does not imply permission to display it. The logo camera remains unchanged during sharing.

Converge's native wrapper reads `/srv/pi/pi-remote/web/dist/meet-adapter.js` and relays it to the platform output page over its authenticated transport. Stable namespace/event keys preserve meeting and thread identity. The wrapper publishes the adapter streams; it does not implement another agent engine or upload/recovery loop.

## Live audio and delegation

`pi-stack-voice.service` is the shared OpenAI Live transport, at loopback port `8796`. Its API credential stays in the systemd credential owner, and durable leases stay in `/var/lib/pi-stack-voice-runtime/sessions.sqlite3`. Meet negotiates client delegation; [telephone calls](calling.md) negotiate no delegation. The person model broker enforces session ownership.

Meet starts muted. The host and `meet_voice` update the same confirmed output state without stopping listening or work. A platform-transcript meeting opens Live when unmuted, or for a minute after a name/unmute mention. Muting keeps it open for one minute; eight unmuted minutes without activity close it, with pending work holding it for at most ten minutes. Local-transcript meetings keep Live open because they lack the platform wake signal. Reopened Live receives the last five minutes of speaker-labelled transcript. Failures report state and retry while wanted; they never change the camera.

The meeting dispatcher receives durable handoffs and dispatches work to the shared thread owner. Workers perform tools, browser controls, research and editing; the dispatcher relays speakable results. [`root-thread-policy.md`](../server/meet/root-thread-policy.md) and [`instructions.ts`](../server/meet/instructions.ts) own meeting instructions. New messages arrive at output boundaries without dropping earlier requests or cancelling existing work.

Native WebRTC carries Opus directly to the external media page, not through its HTTP relay. The adapter requests 80 ms receiver jitter buffering and owns one Web Audio output track, with 60 ms post-decode headroom, 160 ms excess limit and 240 ms capacity. Receiver-property failures are reported in diagnostics without substituting audio. Five-second worklet/RTP diagnostics distinguish packet damage from underruns. Output mute covers both local playout and the published camera audio; input remains live.

## Transcripts and recovery

The person's existing `PI_REMOTE_DATA/supervisor.sqlite3` retains `meet_records` and `meet_transcript`. Platform mode preserves real speaker labels supplied by the platform; local mode admits 16 kHz mono PCM16 durably before acknowledging it and identifies it as a mixed feed. Kenan's spoken output, including unfinished fragments, is retained separately. Camera snapshots are memory-only JPEGs, at most 512,000 bytes each, cleared on source departure; they are not continuous perception or recording.

Local recognition uses the retained CPU Nemotron ONNX INT8 service `pi-stack-meet-recognition.service`. The person broker's UID-gated `/v1/meet/recognition` routes to it; the configured direct loopback endpoint is `ws://127.0.0.1:8797`. [`transcriber.ts`](../server/meet/transcriber.ts) drains queued audio serially. Failure retains audio and an explicit error; retry reuses the original upload ID. `deploy/meet-recognition` owns hash-locked source, model preparation and runtime selection; `PI_STACK_MEET_RECOGNITION_URL` / `PI_STACK_MEET_RECOGNITION_DEST` select its endpoint and tree.

Before a local-mode handoff, `transcriptFlushRevision` requests the current PCM tail. Only unseen transcript text enters each receiving work item, with corrected text labelled and durable landing receipts preserving recovery. Platform mode needs no microphone flush.

`suspend()` immediately stops capture, audio output, camera/browser tracks and polling, then saves pending PCM in its retained outbox. Its handle does not resume capture. `close()` suspends, awaits Live close, reopens the same stable room/host, and replays pending PCM/assistant uploads under their original IDs. Only confirmed uploads permit final room stop. A disconnected relay leaves bytes retained and makes `close()` reject; retry that same handle after reconnecting. `MeetAdapterStartError.recovery` exposes the same close/retry controls if startup cleanup fails.

`ExternalMeetRoom` retries transport failures with five-second attempts and a twenty-second recovery budget; invalid payloads, lost authorization and ended rooms are terminal. Polling renews the host heartbeat. The host expires after 45 seconds without a heartbeat and closes its browser, including a still-opening candidate.

The retained person media runtime owns live rooms, transcription, snapshots and Chromium, **not agent execution**. [`runtime.ts`](../server/meet/runtime.ts) and [`gateway.ts`](../server/meet/gateway.ts) keep it alive across supervisor/core handoffs; a live runtime keeps its immutable source until its last room closes. Idle rotation rechecks rooms and in-flight requests. Explicit person Stop/lock ends the runtime. `meet-runtime.sock` is a generation-qualified alias in the person's mounted state. The runtime binds a unique `meet-INSTANCE.sock` and holds `meet-runtime.owner.lock` in the protected, non-FUSE directory of its declared `PI_CORE_CALLBACK_SOCKET`. That shared host-namespace lock spans sibling encrypted views. Shutdown removes only its own alias token and bound endpoint; Bun never binds the shared alias. Logs and the `meet_runtime_owner` / `meet_live_rooms` ownership mirror remain in private mounted state. The mirror stores the exact generation endpoint, so alias loss reconnects the same PID without replacing rooms. An alive legacy PID with no reachable endpoint is an explicit custody error, not permission to start another runtime. Deployment must retain this `meet-runtime-v1` / `person-service` lifetime contract and never replace live media just to adopt code.

Final platform turns may invoke the configured ordered `PI_MEET_TRANSCRIPT_HOOK` (or `~/.config/pi-stack/meet-transcript-hook`) with speaker-labelled JSON stdin and a twelve-second bound. Any screen control performed by a host hook must obey the same requested-shared-browser presentation contract.

## API

- `POST /v1/meet/external`: `{namespace,eventKey,name?,transcript?}` → `{room,participant}`. `transcript` is `local` or `platform`; an omitted mode uses the established local-transcript contract.
- `POST /v1/meet/external/ROOM/stop`: ends external participation.
- `GET /v1/meet/external/transcript?namespace=NS&eventKey=KEY&format=text`: saved export; omit `format` for JSON.

Operations beneath `/v1/meet/ROOM`:

| Operation | Request |
| --- | --- |
| Snapshot / source heartbeat | `GET /` or `/poll?participant=ID` |
| Register camera source | `POST /join`, `{name}` |
| Leave/end as host | `POST /leave?participant=ID` |
| Publish/delete source JPEG | `PUT` / `DELETE /frame?participant=ID` |
| Read source JPEG | `GET /participants/ID/frame` |
| Queue local PCM | `POST /transcript/audio?participant=HOST&id=UUID&startedAt=MS`, `audio/pcm` |
| Save platform turn | `POST /transcript/turn?participant=HOST`, `{id,speakerId,speaker,text,startedAt,final?}` |
| Save Kenan speech | `POST /transcript/assistant?participant=HOST`, `{id,text,final,startedAt,voiceSessionId?,startMs?,endMs?}` |
| Acknowledge PCM flush | `POST /transcript/flushed?participant=HOST`, `{revision,error?}` |
| Retry retained audio | `POST /transcript/retry?participant=HOST` |
| Export room transcript | `GET /transcript`, optional `?format=text` |
| Set output mute | `POST /voice?participant=HOST`, `{muted}` |
| Requested browser start/navigation/watch | `POST /browser?participant=HOST`, `{requested:true,url?,watch?}` |
| Browser connection/JPEG | `GET /browser` or `/browser/frame` |
| Stop shared browser | `DELETE /browser?participant=HOST` |

`PI_MEET_CHROMIUM` selects the installed browser executable. Agents connect `agent_browser` to the returned CDP endpoint. Focused/new tabs become the shared tab; CDP frames plus periodic still captures keep static pages visible. Temporary profiles and source watchers belong to browser cleanup.

## Ownership

Source owners are `server/meet`, `server/voice` and `web/src/meet`. Shared threads, model/account custody and image execution belong to core; this adapter does not copy them. Preserve saved transcripts, retained upload bytes, runtime mirrors and Live leases during cutover. [Deployment](../../../docs/deployment.md) owns service adoption.
