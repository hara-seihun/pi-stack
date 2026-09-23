# PiStack Meet

Meet is `/meet.html` in the regular Pi Remote frontend. The thread header's camera icon beside the settings gear opens it with that thread and environment selected. A host chooses her name and devices, starts the room, and shares its invite link. Guests need network access to the Pi Remote host. The host's supervisor must remain unlocked.

## Media

Each person publishes a separate camera/audio MediaStream over WebRTC. The room adds two outgoing PiStack streams:

- `pi-camera` contains Kenan's artwork, Voice/mute/playback state and the connected threads' tool activity and assistant output. Its square dashboard rotates through thread details. Voice's audible output is its audio track.
- `pi-screen` contains the host-controlled Chromium tab, sampled at five frames per second.

The host tab runs the Voice connection. It mixes participant microphones only into Voice's single conversational audio input. Voice output never enters that mixer. Independently, the host captures each participant's microphone through its own AudioWorklet. Silence or a twelve-second bound closes an utterance; PiStack transcribes that source with a local, multilingual Whisper base model. Speaker identity comes from the stream's participant ID and name, not a guess from mixed audio. Two people speaking at once produce independent transcript entries. Duplicate display names remain distinct through their IDs.

Meet saves Kenan's spoken output, including unfinished fragments, separately from participant recognition. It ignores Voice's mixed-room user transcript in favour of the independently transcribed microphones. Rooms start with Kenan muted. The host control and agents' `meet_voice` tool change the same server-owned mute state; listening and work continue while muted. End meeting stops camera, microphone and playback immediately, then saves the final speech before leaving the room. A save failure keeps capture stopped and leaves the finalization available for retry.

Delegation reuses a suitable existing worker thread by default. `threadId` selects a particular worker; `newThread` requests independent concurrent work. Every meeting-associated thread receives the shared room/browser context and the reviewed livedev skill from the installed release.

### Meeting thread and workers

The thread a room is attached to is the meeting root. Voice submits every handoff to it with `hardSteer`, so the request cancels the root's local work and runs immediately; a hard steer to the root does not stop its descendants. The root's instructions ([`server/meet/root-thread-policy.md`](../server/meet/root-thread-policy.md)) therefore keep it free: it handles only requests that finish in one or two tool calls, hands anything longer to a worker with `thread_spawn` or `thread_send` before taking a first step, and relays worker results to the room. Worker threads spawned from the root inherit the meeting through their parent, get the same meeting tools, browser access and livedev skill, and receive a worker note telling them to do the work there and report back. [`server/meet/instructions.ts`](../server/meet/instructions.ts) composes both variants; `GET /v1/sessions/ID/instructions` selects by the thread's Orchestrator role. Voice's own instructions carry the livedev skill without the thread-routing policy.

Before delivering meeting work, the supervisor increments `transcriptFlushRevision`. The host sees it in the room poll, flushes its microphone buffers and acknowledges `/transcript/flushed` with `{revision}` or `{revision,error}`. The server then waits for the bounded recognition snapshot and computes what the receiving thread has not seen. Durable work-item receipts record each delivered turn's text. A continuation receives only its new suffix; a corrected turn is labelled as a correction. Delivery state belongs to each thread, not the browser or a global meeting cursor, so another worker can receive its own missing history. Voice handoffs also retain Voice's new transcript fragments, including the speech that triggered delegation. Flushing the saved meeting transcript must not discard those fragments: on September 14, Converge delivered eight handoffs without them, and the agent returned empty answers while Kenan remained muted. The independently recognized transcript remains the saved meeting record. Failed flushes or transcription retain the queued work and report the recovery needed instead of delivering incomplete speech.

Every participant with a camera uploads a JPEG every two seconds, preserving the source aspect ratio and limiting the longest edge to 960 pixels. The agent can read the latest image through the room API. These are snapshots, not continuous video perception by the voice model. Meet retains only the latest frame per participant in memory. It does not keep a video or mixed-audio recording. Microphone audio remains in the transcription queue until processed; failed jobs retain their audio for recovery. A completed transcription clears its audio. Voice requests delegated to Pi also remain in the thread's ordinary history.

The current web adapter uses peer-to-peer connections and admits at most twelve people. A host advertises its TURN servers through `iceServers` in `/etc/pi-stack/meet.json`, for example:

```json
{
  "iceServers": [{
    "urls": ["turn:PRIVATE_HOST:3478?transport=udp", "turn:PRIVATE_HOST:3478?transport=tcp"],
    "username": "YOUR_TURN_USERNAME",
    "credential": "YOUR_TURN_CREDENTIAL"
  }]
}
```

`PI_STACK_MEET_FILE` selects a different component configuration file. The separate file survives host provisioning that regenerates `host.json`. This configuration is sent to joining browsers. Do not put an administrative credential here. The host owns the relay and its access boundary. An empty list permits direct connections only. Private HTTP is sufficient for server API calls; browser camera and microphone capture require localhost or HTTPS. Tailscale Serve can provide HTTPS within a tailnet, and a host can configure a tailnet-only coturn relay for environments that cannot connect directly.

## Browser sharing

Share browser starts a new, isolated Chromium context on the selected PiStack host. It does not reuse another browser's login or profile. `PI_MEET_CHROMIUM` selects an executable; otherwise the host's `chromium` or `google-chrome` command must exist. PiStack's pinned `playwright-core` dependency controls startup, CDP screencasting, navigation, and shutdown.

The API reports a loopback CDP endpoint. The connected agent can attach its ordinary `agent_browser` tool using `connect ENDPOINT` with `sessionMode: "fresh"`, then `get url`, `snapshot -i`, and the normal browser controls. Newly opened or focused tabs become the broadcast tab. Closing that tab selects a remaining one. The page's Address field navigates the shared tab.

Meeting agents also have `meet_room`, `meet_voice`, `meet_share_screen` and `meet_stop_sharing`. `meet_share_screen` can open an app URL and watch an absolute source directory for page reloads. Apps with their own hot reload need no watcher. Stopping sharing closes Chromium and its watcher. Watch and navigation failures appear in the room state.

Chromium profiles live in temporary `pi-meet-*` directories and are deleted when the browser closes. The browser closes with the host's room, including a host departure during startup. An ungraceful host loss expires its room after 45 seconds without polling. Supervisor deployment or restart ends live media connections; guests see the disconnection and can rejoin a new room. Saved transcripts and accepted transcription jobs survive. Interrupted jobs resume when the supervisor starts.

## Saved transcripts and recovery

The person's existing `PI_REMOTE_DATA/supervisor.sqlite3` owns `meet_records` and `meet_transcript`. For encrypted identities, that data directory is inside the person's mounted private folder. The meeting record links the transcript to its Pi Remote thread. This is the canonical transcript, not browser sessionStorage. Every participant can read the live transcript in the room. The Meet lobby lists saved transcript downloads after a meeting ends. Text downloads prefix every sentence with timestamp, speaker name and participant ID. JSON retains the original turn boundaries and completion state.

Audio enters SQLite before an acknowledgement is returned to the host. The recognizer keeps its model loaded and processes each source independently. Successful jobs remove their PCM bytes; failed jobs retain them with an error. Retry transcription resubmits any browser-held unacknowledged uploads under the same IDs and requeues failed server jobs. `POST /ROOM/transcript/retry` also works after the room ends. Explicit End meeting flushes and acknowledges the last captured speech before closing. Force-closing or losing the host tab can lose audio that had not yet reached the server; already acknowledged audio and text remain saved.

[`deploy/transcription`](../../../deploy/transcription) installs the hash-locked Python dependencies and revision-pinned model under `/srv/pi/.pi-transcription/HASH`, with `/srv/pi/transcription` selecting the prepared tree. It requires `uv` and uses Python 3.12. The model provenance and dependency lock live in [`server/meet/asr`](../server/meet/asr). No transcription API key is used and microphone audio does not leave the selected PiStack host for recognition. The conversational Voice connection still sends audio to its existing provider. `deploy/host` prepares transcription alongside runtime dependencies. `PI_STACK_TRANSCRIPTION_DEST` selects a different runtime for deployment rehearsals and supervisor operation.

The shared Voice service is `pi-stack-voice.service` on loopback port `8796`. Ordinary supervisors use their configured [person broker](../../../packages/orchestrator/docs/ordinary-users.md#voice-access), which enforces Voice session ownership without granting direct access to the shared port. Its OpenAI API credential stays with the host's credential owner and reaches the dynamic service user through systemd. It is not an Orchestrator OAuth consumer. Voice session leases survive service restart in `/var/lib/pi-stack-voice-runtime/sessions.sqlite3`. [Deployment](../../../docs/deployment.md) owns unit installation, release identity checks and rollback.

Converge owns its Recall/calendar credentials, scheduling, attendance policy and platform records. Its Recall transcript can retain platform speaker attribution. Recall's browser microphone supplies mixed audio to the shared adapter, so PiStack labels that source `Mixed meeting audio` rather than inventing individual speakers.

## Adapter contract

[`server/meet/protocol.ts`](../server/meet/protocol.ts) owns room snapshots, signaling messages, and stream kinds. [`web/src/meet/media.ts`](../web/src/meet/media.ts) defines `MeetMediaSource`, which carries a participant, a stream kind, and a MediaStream. `MeetMedia.attach` supplies a participant's audio to Voice without losing the original stream. `detach` removes that participant from the mixer.

[`MeetRoom`](../web/src/meet/room.ts) handles room polling, signaling and participant streams. `publish(kind, stream)` publishes camera, audio, and browser media; `onMedia` delivers each remote participant's labelled streams separately.

[`web/src/meet/adapter.ts`](../web/src/meet/adapter.ts) exports `startMeetAdapter({request, namespace, eventKey, name?, container})`. It returns state, camera/browser streams, `suspend`, `close`, mute, sharing and recovery controls. The injected `request` has type `(path: string, init: RequestInit) => Promise<Response>`. It preserves HTTP status, headers, text/binary bodies and `init.signal` cancellation across the transport. All room, Voice, transcript and browser API traffic uses it. The regular build emits a standalone ESM `web/dist/meet-adapter.js` containing its artwork and microphone worklet, with no sibling asset dependency.

Converge's native wrapper reads that exact installed bundle from `/srv/pi/pi-remote/web/dist/meet-adapter.js` and transfers it over its existing authenticated WebSocket relay to the thin Recall output page. The page imports it as an ES module, then calls `startMeetAdapter` with its relay request function and stable calendar identity. It does not load Pi Remote's standalone page bootstrap or select a person through browser-local state. Await `close()` before ending a graceful meeting so pending speech reaches durable storage; an aborted request or failed close reports an error rather than claiming that transcript delivery succeeded. It forwards API traffic to the person's Pi Remote supervisor through the normal router. Pi Remote stays private; no extra listener or public Remote endpoint is needed. Converge owns transport authorization and restricts it to the relevant meeting operations. PiStack owns the renderer, Voice, recognition, thread delegation and transcript delivery. There is no separate Converge meeting engine or copied browser bundle.

### Disconnect and shutdown

`suspend(): Promise<void>` immediately stops physical microphone tracks, silences Voice input/output, and stops camera/browser media and room polling before awaiting anything. It then flushes unfinished PCM into the retained upload outbox. State becomes `suspended`; that handle never resumes capture.

`close()` owns recovery. It suspends capture, awaits Voice shutdown, reopens the same stable external room and host, then replays retained PCM and assistant uploads under their original IDs. Only acknowledged uploads permit capture disposal and the final external-room stop. A disconnected relay makes `close()` reject while retaining the bytes. After reconnect, call `close()` again on the same handle. The wrapper does not implement another upload or room-recovery loop. `retryTranscription()` remains available without restarting suspended capture.

If startup fails and cleanup cannot finish, `MeetAdapterStartError.recovery` retains `state`, `suspend`, `close` and `retryTranscription`. Keep that recovery handle and complete its `close()` before starting a replacement adapter. Dropping the handle or destroying its page can lose audio that the server has not acknowledged.

### External room API

`POST /v1/meet/external` takes `{namespace,eventKey,name?}` and returns the ordinary `{room,participant}` shape. The namespace and stable event key select deterministic room/thread identities. Repeated starts reuse their stored history. External rooms admit 32 camera image sources plus their host; these sources do not form a WebRTC peer mesh. Ordinary peer-to-peer rooms retain their twelve-person limit. The host participant is explicitly `Mixed meeting audio`. `POST /v1/meet/external/ROOM/stop` ends that room. `GET /v1/meet/external/transcript?namespace=NS&eventKey=KEY`, optionally `format=text`, exports its saved transcript and reports the room/thread IDs in response headers.

The supervisor owns these endpoints, all below `/v1/meet`:

| Operation | Request |
| --- | --- |
| Create a room and join as host | `POST /`, JSON `{sessionId, name}` |
| List rooms | `GET /` |
| Read room, participants, ICE servers, browser endpoint | `GET /ROOM` |
| Join a room | `POST /ROOM/join`, JSON `{name}` |
| Read and acknowledge signaling | `GET /ROOM/poll?participant=ID&after=SEQ` |
| Send SDP, ICE, or stream labels | `POST /ROOM/signal?participant=ID`, JSON `{to, signal}` |
| Leave, or end the room as host | `POST /ROOM/leave?participant=ID` |
| Publish latest camera snapshot | `PUT /ROOM/frame?participant=ID`, `image/jpeg` |
| Submit one labelled microphone utterance | `POST /ROOM/transcript/audio?participant=HOST_ID&speaker=SOURCE_ID&id=UUID&startedAt=MILLISECONDS`, mono 16 kHz PCM16, `audio/pcm` |
| Save a Voice turn | `POST /ROOM/transcript/assistant?participant=HOST_ID`, JSON `{id,text,final,startedAt}`, optionally `voiceSessionId,startMs,endMs` for output fragments |
| Acknowledge a requested microphone flush | `POST /ROOM/transcript/flushed?participant=HOST_ID`, JSON `{revision,error?}` |
| Mute or unmute Kenan | `POST /ROOM/voice?participant=HOST_ID`, JSON `{muted}` |
| Read saved transcript | `GET /ROOM/transcript`, or `?format=text` for a sentence-labelled download |
| List a thread's meetings | `GET /?sessionId=THREAD_ID` |
| Retry failed recognition | `POST /ROOM/transcript/retry?participant=HOST_ID`; the participant parameter is unnecessary once the room has ended |
| Read a camera snapshot | `GET /ROOM/participants/ID/frame` |
| Start or navigate the shared browser | `POST /ROOM/browser?participant=HOST_ID`, JSON `{url}` |
| Read browser connection or JPEG | `GET /ROOM/browser` or `/ROOM/browser/frame` |

Create and join return `{room, participant}`. Polling is also the participant heartbeat. Messages remain in their recipient's mailbox until acknowledged, so a lost response does not lose an offer. The client uses WebRTC's polite-peer offer-collision handling for simultaneous joins and track changes. Participant IDs address participants within the host's existing private-network trust boundary; they are not a separate login mechanism.

## Ownership and checks

Implementation belongs to `apps/remote/server/meet` and `apps/remote/web/src/meet`. The regular build includes the page and standalone adapter; `deploy/host` publishes their server, assets, Voice service code, livedev skill and browser dependency with the rest of Pi Remote. Its staged-artifact check resolves imports outside the checkout's hoisted dependencies, and its live smoke checks Meet, Voice release identity and transcription availability. Host-specific TURN addresses and Chromium installation belong to host configuration.

`bun test apps/remote/server/meet.test.ts` exercises signaling acknowledgement, recipient isolation, host cleanup during browser startup, and per-person frame deletion. `npm run typecheck --workspace=pi-remote` checks the shared browser and server contracts. A deployed media check should join two clients, check separate camera and PiStack streams, navigate the shared browser, and leave the room. A forced-relay WebRTC connection checks TURN separately from a same-machine direct connection.
