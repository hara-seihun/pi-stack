# External meeting participation

Pi Stack participates in meetings hosted by external platforms. The standalone ESM `meet-adapter.js` supplies Kenan's camera dashboard, conversational GPT Voice, shared browser, agent delegation and transcript delivery. The external integration owns scheduling, attendance, platform credentials and transport authorization. Shared human chat rooms have their own [room service](rooms.md); standalone [Voice](speech.md) has its own page and lifecycle.

## Adapter contract

[`web/src/meet/adapter.ts`](../web/src/meet/adapter.ts) exports `startMeetAdapter({request, namespace, eventKey, name?, container})`. It returns state, camera/browser streams, `suspend`, `close`, mute, sharing and recovery controls. The injected `request` is `(path: string, init: RequestInit) => Promise<Response>` and preserves HTTP status, headers, text/binary bodies and `init.signal` cancellation. All meeting, Voice, transcript and browser API traffic uses it. The regular build emits `web/dist/meet-adapter.js` with its artwork and microphone worklet, without sibling asset dependencies.

Converge's native wrapper reads that installed bundle from `/srv/pi/pi-remote/web/dist/meet-adapter.js` and transfers it over its authenticated WebSocket relay to Recall's output page. The page imports the ESM module and starts it with stable calendar identity and its relay request function. It does not select a person through browser-local state. API requests reach the person's supervisor through the ordinary router; Pi Remote stays private. The wrapper restricts its relay to the relevant meeting operations.

[`ExternalMeetRoom`](../web/src/meet/external-room.ts) owns external room polling and confirmed Voice state, not participant media transport. Polling is the external host's heartbeat. Network failures, timeouts and HTTP 502/503/504 retry with five-second attempts and a twenty-second recovery budget, preserving meeting identity and Voice state. Invalid payloads, lost authorization and ended meetings are terminal. Explicit suspend cancels recovery. A live-media hold postpones client updates until the adapter or standalone Voice closes.

The external host's microphone is labelled `Mixed meeting audio`. The platform supplies participant cameras as JPEG snapshots through the room API. Snapshot-source registration does not establish a media connection. Kenan's outgoing `cameraStream` contains the generated dashboard and Voice audio; `browserStream` contains the agent-controlled browser sampled at five frames per second. The external platform publishes these streams to its call.

### Disconnect and shutdown

`suspend(): Promise<void>` immediately stops physical microphone tracks, silences Voice input/output, stops camera/browser media and polling, then flushes unfinished PCM into the retained upload outbox. State becomes `suspended`; that handle never resumes capture.

`close()` owns recovery. It suspends capture, awaits Voice shutdown, reopens the same stable external meeting and host, then replays retained PCM and assistant uploads under their original IDs. Only acknowledged uploads permit capture disposal and final external-room stop. A disconnected relay makes `close()` reject while retaining bytes. After reconnection, call `close()` again on that same handle. `retryTranscription()` can recover uploads without restarting suspended capture. The wrapper does not implement another upload or room-recovery loop.

If startup fails and cleanup cannot finish, `MeetAdapterStartError.recovery` retains `state`, `suspend`, `close` and `retryTranscription`. Complete that handle's `close()` before replacing the adapter. Destroying its page can lose audio that the server has not acknowledged.

## Voice and audio

The shared service is `pi-stack-voice.service` on loopback port `8796`. Ordinary supervisors use their [person broker](../../../packages/orchestrator/docs/ordinary-users.md#voice-access), which enforces Voice session ownership. The OpenAI API credential stays with the host credential owner and reaches the dynamic service user through systemd. Voice session leases survive service restart in `/var/lib/pi-stack-voice-runtime/sessions.sqlite3`. [Deployment](../../../docs/deployment.md) owns unit installation, release identity checks and rollback.

Meetings start with Kenan muted. The host API and agents' `meet_voice` tool update the same server-owned mute state; listening and work continue while muted. Voice's mixed-room user transcript is not substituted for the speaker-labelled platform record. Kenan's spoken output, including unfinished fragments, is saved separately.

GPT-Live sends an Opus track by WebRTC directly to Recall's output-media Chromium page; speech does not travel through Converge's HTTP/WebSocket relay. The page captures audible DOM audio into the call. The adapter asks the audio RTP receiver for 80 ms pre-decode jitter buffering (`RTCRtpReceiver.jitterBufferTarget`). It owns playback through one Web Audio destination track created before the camera starts, with an AudioWorklet clock and 60 ms post-decode headroom (160 ms excess limit, 240 ms capacity). If Chromium lacks or rejects the receiver property, diagnostics record that without breaking playback. Voice's own `<audio>` sink is disabled for this adapter. Muting affects both the page sink and published camera track, not the model's full-duplex input.

Worklet and inbound RTP counters are sent every five seconds as `pistack_audio_diagnostic` through the existing relay. RTP jitter, packet loss, received bytes, jitter-buffer delays and concealed samples distinguish upstream damage from playout underruns. Delay counters are cumulative: divide by emitted samples before comparing with the 80 ms target. A client MP4 remains the end-to-end playback record.

### Voice on demand

GPT-Live bills while a session is open, muted or not. A platform-transcript meeting opens Voice only when wanted, through [`voice-demand.ts`](../web/src/meet/voice-demand.ts):

- Unmuting opens Voice. Eight minutes unmuted without Kenan speaking or delegating closes it; unsettled work holds it for up to ten minutes.
- A platform turn names Kenan or says “unmute yourself”. [`mention.ts`](../server/meet/mention.ts) accepts common recognizer spellings. The server records one `voiceWake` per turn; the adapter pre-warms Voice for one minute.
- If Voice missed that mention, the adapter sends a `Meeting mention` to the root with `steer`, including unseen meeting transcript. The root answers or delegates actual requests and ignores passing mentions.
- Muting leaves Voice open for one more minute, then closes it.

A reopened Voice session receives the last five minutes of speaker-labelled transcript. Camera frames, transcripts, the dashboard and shared browser continue while Voice is closed. Voice failure appears on the dashboard and retries after fifteen seconds while wanted. Meetings using local mixed-feed recognition keep Voice open because they lack a cheap platform wake signal.

## Threads, delegation and saved transcripts

The external meeting thread is the root. Voice hard-steers handoffs to it; a hard steer does not stop descendants. [`root-thread-policy.md`](../server/meet/root-thread-policy.md) keeps the root free: it handles one- or two-tool-call requests, delegates longer work before taking a first step, and relays results. Workers inherit meeting tools, browser access and the installed livedev skill. [`instructions.ts`](../server/meet/instructions.ts) composes root/worker instructions. The dashboard shows the root and all workers using the inbox's status words; finished ephemeral workers read Done.

Each meeting thread uses orchestrator mode `live`, declared in [`threads/modes.ts`](../../../packages/orchestrator/src/threads/modes.ts). New meetings use Sol, low thinking and priority speed. A recurring thread keeps its model and thinking, reopens if archived and enters live mode; it takes mode speed only when supported. Open meetings protect their threads and ancestors from auto-archive.

The person's existing `PI_REMOTE_DATA/supervisor.sqlite3` owns `meet_records` and `meet_transcript`; encrypted identities keep them in the mounted private folder. The canonical saved record is not browser storage. Text exports include timestamps, speaker names and speaker IDs; JSON retains turn boundaries and completion state.

`transcript: "platform"` uses the external platform's speaker-labelled turns. Converge relays Recall's `transcript.data` utterances to `/ROOM/transcript/turn`, with real participant names and `recall:ID` identities. The adapter does not upload that mixed feed for local recognition. Kenan's own speech still comes from Voice.

For `transcript: "local"`, accepted mono PCM16 enters SQLite before acknowledgement. Successful recognition clears audio; failed jobs retain it and their error. Retry reuses upload IDs and requeues failed jobs. End-of-meeting recovery preserves pending speech. The mixed feed remains explicitly unattributed; it does not invent individual speakers.

External Meet submits durably queued 16 kHz mono PCM16 turns (maximum sixteen seconds) to raw English Nemotron ONNX INT8 CPU recognition. `pi-stack-meet-recognition.service` owns the resident model independently of supervisors. The broker-only `/v1/meet/recognition` forwards person UID-gated audio; the administrator uses direct loopback `ws://127.0.0.1:8797`. [`deploy/meet-recognition`](../../../deploy/meet-recognition) prepares hash-locked runtime, weights and source under `/srv/pi/.pi-meet-recognition`, selected by `/srv/pi/meet-recognition`. `deploy/prepare` fetches without activation; host activation selects the tree and `deploy/meet-recognition-service` checks its listener. `PI_STACK_MEET_RECOGNITION_URL` and `PI_STACK_MEET_RECOGNITION_DEST` choose the endpoint/runtime. The retained [`transcriber.ts`](../server/meet/transcriber.ts) owns queued recognition without dictation cleanup or rewriting. Failure retains audio for retry. Platform transcripts require no local ASR; conversational Voice stays with its existing provider.

Before delegating local-transcript work, the supervisor increments `transcriptFlushRevision`. The adapter flushes its microphone and acknowledges `/transcript/flushed` with `{revision}` or `{revision,error}`. Platform-transcript meetings need no microphone flush. The server computes what the receiving thread has not seen, using durable per-work-item receipts. Continuations receive new suffixes; corrected text is labelled as a correction. Voice handoffs also retain triggering Voice fragments. Failed flush/recognition leaves work queued with its recovery error.

Each snapshot source uploads a JPEG about every two seconds, preserving aspect ratio and limiting the longest edge to 960 pixels. Agents can read the latest source image or receive images on delegation. Frames are memory-only, limited to one per source and cleared on departure; this is not continuous video perception or recording.

For each final platform turn, [`transcript-hook.ts`](../server/meet/transcript-hook.ts) invokes `PI_MEET_TRANSCRIPT_HOOK`, or executable `~/.config/pi-stack/meet-transcript-hook`. JSON stdin includes `roomId`, `sessionId`, `id`, `speaker`, `speakerId`, `text`, `startedAt`; `PI_REMOTE_SESSION_ID` and `PI_MEET_ROOM_ID` identify context. The hook prints a JSON line; results other than `{"handled":false}` are logged. Turns run in order with a twelve-second bound. Converge's canvas hook handles slide/video controls without waiting for a model turn; Pi Stack itself interprets no hook commands.

## Shared browser and lifetime

`meet_share_screen` starts isolated Chromium, optionally opens a URL and watches an absolute source directory for reloads. `meet_stop_sharing` closes Chromium and its watcher. `meet_room` reads meeting participants and browser state; `meet_voice` changes outgoing mute state. `PI_MEET_CHROMIUM` selects an executable; otherwise `chromium` or `google-chrome` must exist. The pinned `playwright-core` controls launch, navigation, CDP and cleanup. Temporary `pi-meet-*` profiles are deleted on close.

Agents attach `agent_browser` with `connect ENDPOINT`, `sessionMode: "fresh"`, then use snapshots and browser controls. Newly focused/opened tabs become the shared tab; closing it selects a remaining one. The adapter provides browser frames even for still pages, refreshing by screenshot if CDP screencasting is quiet for a second. Navigation/watch failures appear in meeting state.

The independent per-person [`meeting runtime`](../server/meet/runtime.ts) owns external meeting state, camera snapshots, mute/wake revisions, transcript processing and shared Chromium. The [`gateway`](../server/meet/gateway.ts) attaches each supervisor generation to its private Unix socket. Ongoing meetings survive supervisor replacement; the runtime retains its immutable release until all meetings close. Idle-only replacement rechecks rooms and in-flight requests. Its process remains in the person's systemd cgroup and encrypted-folder namespace; explicit Stop/lock ends it. The host expires after 45 seconds without heartbeat, closing its browser even during startup.

`meeting-runtime.json` and connected supervisor health advertise `meet-runtime-v1` / `person-service`. Deployment's restart census admits a handoff only with the lifetime contract, otherwise waits. `PI_REMOTE_DATA/meet-runtime.sock` and `meet-runtime.log` are mode `0600`; the socket lock owns worker lifetime. The existing database's `meet_runtime_owner` and `meet_live_rooms` mirror live ownership transactionally with transcript creation/closure.

## External API

`POST /v1/meet/external` takes `{namespace,eventKey,name?,transcript?}` and returns `{room,participant}`. Stable namespace/event key choose deterministic meeting/thread IDs. `transcript` is `local` when omitted, or `platform`. Repeated starts preserve identity and history. A snapshot has participants, Voice state/revisions, platform-transcript mode, thread activity, microphone flush revision and optional shared-browser connection.

`POST /v1/meet/external/ROOM/stop` ends participation. `GET /v1/meet/external/transcript?namespace=NS&eventKey=KEY`, optionally `format=text`, exports the saved record; response headers identify meeting/thread IDs.

All remaining operations below `/v1/meet` operate on an external meeting:

| Operation | Request |
| --- | --- |
| List active meetings and saved records | `GET /`, optionally `?sessionId=THREAD_ID` |
| Read meeting state | `GET /ROOM` |
| Register a platform camera snapshot source | `POST /ROOM/join`, JSON `{name}`; up to 32 sources plus the external host |
| Poll state and renew source heartbeat | `GET /ROOM/poll?participant=ID` |
| Leave as a source, or end as host | `POST /ROOM/leave?participant=ID` |
| Publish/delete source JPEG | `PUT` / `DELETE /ROOM/frame?participant=ID` |
| Read camera snapshot | `GET /ROOM/participants/ID/frame` |
| Upload mixed audio, local mode only | `POST /ROOM/transcript/audio?participant=HOST_ID&speaker=HOST_ID&id=UUID&startedAt=MILLISECONDS`, mono 16 kHz PCM16, `audio/pcm` |
| Save Kenan's Voice turn | `POST /ROOM/transcript/assistant?participant=HOST_ID`, JSON `{id,text,final,startedAt}`, optional `voiceSessionId,startMs,endMs` |
| Save platform-recognized turn | `POST /ROOM/transcript/turn?participant=HOST_ID`, JSON `{id,speakerId,speaker,text,startedAt,final?}` |
| Acknowledge microphone flush | `POST /ROOM/transcript/flushed?participant=HOST_ID`, JSON `{revision,error?}` |
| Mute/unmute Kenan | `POST /ROOM/voice?participant=HOST_ID`, JSON `{muted}` |
| Read saved transcript | `GET /ROOM/transcript`, optional `?format=text` |
| Retry failed local recognition | `POST /ROOM/transcript/retry?participant=HOST_ID`; participant unnecessary after the meeting ends |
| Start/navigate/watch shared browser | `POST /ROOM/browser?participant=HOST_ID`, JSON `{url?,watch?}` |
| Read browser connection/JPEG | `GET /ROOM/browser` or `/ROOM/browser/frame` |
| Stop shared browser | `DELETE /ROOM/browser?participant=HOST_ID` |

Participant IDs address sources within the host's existing private-network trust boundary; they are not another login mechanism.

## Ownership and checks

Implementation belongs to `server/meet` and `web/src/meet`. The normal release publishes the standalone adapter, server, Voice and livedev skill. Sparse checks cover removed hosting endpoints, external recovery and Voice lifecycle, speaker-labelled turns, camera-source cleanup, shared-browser startup cleanup and actual supervisor-process replacement:

```sh
bun test apps/remote/server/meet.test.ts apps/remote/server/meet/external.test.ts apps/remote/server/meet/runtime.test.ts apps/remote/web/meet-adapter.test.ts apps/remote/web/meet-room-recovery.test.ts apps/remote/web/meet-recovery.test.ts apps/remote/web/meet-voice-demand.test.ts
```
