# PiStack Meet

Meet is `/meet.html` in the regular Pi Remote frontend. The thread header's Meet link opens it with that thread and environment selected. A host chooses her name and devices, starts the room, and shares its invite link. Guests need network access to the Pi Remote host. The host's supervisor must remain unlocked.

## Media

Each person publishes a separate camera/audio MediaStream over WebRTC. The room adds two outgoing PiStack streams:

- `pi-camera` contains the same `/kenan.png` artwork used by the client and PiStack Voice's audio output.
- `pi-screen` contains the host-controlled Chromium tab, sampled at five frames per second.

The host tab runs the Voice connection. It mixes participant microphones only into Voice's single conversational audio input. Voice output never enters that mixer. Independently, the host captures each participant's microphone through its own AudioWorklet. Silence or a twelve-second bound closes an utterance; PiStack transcribes that source with a local, multilingual Whisper base model. Speaker identity comes from the stream's participant ID and name, not a guess from mixed audio. Two people speaking at once produce independent transcript entries. Duplicate display names remain distinct through their IDs.

Voice's `turn.created`, `turn.delta`, and `turn.done` events save Kenan's speech, including unfinished turns. Meet ignores Voice's mixed-room user transcript in favour of the separately transcribed microphones. The existing delegation path sends work to the chosen Pi Remote thread and returns the agent's progress through Voice.

Before a handoff, Meet flushes unfinished microphone utterances, waits for their durable save acknowledgements and transcription, and takes a bounded transcript snapshot. Later speech does not keep that handoff waiting. The request includes JSON `meetingTranscript` turns with `id`, `speakerId`, `speaker`, `startedAt`, `text`, and `final`, plus room metadata and browser/camera URLs. Each handoff includes the complete snapshot rather than maintaining a second delivery cursor. Failed transcription stops the handoff and reports the error; it never substitutes guessed speaker labels or incomplete speech.

Every participant with a camera also uploads one 640×360 JPEG every two seconds. The agent can read the latest image through the room API. These are snapshots, not continuous video perception by the voice model. Meet retains only the latest frame per participant in memory. It does not keep a video or mixed-audio recording. Microphone audio remains in the transcription queue until processed; failed jobs retain their audio for recovery. A completed transcription clears its audio. Voice requests delegated to Pi also remain in the thread's ordinary history.

The current web adapter uses peer-to-peer connections and admits at most twelve people. A host advertises its TURN servers through `meetIceServers` in `/etc/pi-stack/host.json`, for example:

```json
{
  "meetIceServers": [{
    "urls": ["turn:PRIVATE_HOST:3478?transport=udp", "turn:PRIVATE_HOST:3478?transport=tcp"],
    "username": "YOUR_TURN_USERNAME",
    "credential": "YOUR_TURN_CREDENTIAL"
  }]
}
```

This configuration is sent to joining browsers. Do not put an administrative credential here. The host owns the relay and its access boundary. An empty list permits direct connections only. Private HTTP is sufficient for server API calls; browser camera and microphone capture require localhost or HTTPS. GMKtec publishes the page through Tailscale Serve and provides a tailnet-only coturn relay for both environments.

## Browser sharing

Share browser starts a new, isolated Chromium context on the selected PiStack host. It does not reuse another browser's login or profile. `PI_MEET_CHROMIUM` selects an executable; otherwise the host's `chromium` or `google-chrome` command must exist. PiStack's pinned `playwright-core` dependency controls startup, CDP screencasting, navigation, and shutdown.

The API reports a loopback CDP endpoint. The connected agent can attach its ordinary `agent_browser` tool using `connect PORT` with `sessionMode: "fresh"`, then `get url`, `snapshot -i`, and the normal browser controls. Operate the shared tab. Creating another tab does not change which tab Meet broadcasts. The page's Address field navigates that same tab.

Chromium profiles live in temporary `pi-meet-*` directories and are deleted when the browser closes. The browser closes with the host's room, including a host departure during startup. An ungraceful host loss expires its room after 45 seconds without polling. Supervisor deployment or restart ends live media connections; guests see the disconnection and can rejoin a new room. Saved transcripts and accepted transcription jobs survive. Interrupted jobs resume when the supervisor starts.

## Saved transcripts and recovery

The person's existing `supervisor.sqlite3` owns `meet_records` and `meet_transcript`. On GMKtec, Kenan's database is `~/hara/.pi-remote/supervisor.sqlite3`, inside her encrypted folder. The meeting record links the transcript to its Pi Remote thread. This is the canonical transcript, not browser sessionStorage. Every participant can read the live transcript in the room. After the meeting, selecting its thread on the Meet page lists saved transcript downloads. Text downloads prefix every sentence with timestamp, speaker name and participant ID. JSON retains the original turn boundaries and completion state.

Audio enters SQLite before an acknowledgement is returned to the host. The recognizer keeps its model loaded and processes each source independently. Successful jobs remove their PCM bytes; failed jobs retain them with an error. Retry transcription resubmits any browser-held unacknowledged uploads under the same IDs and requeues failed server jobs. `POST /ROOM/transcript/retry` also works after the room ends. Explicit End meeting flushes and acknowledges the last captured speech before closing. Force-closing or losing the host tab can lose audio that had not yet reached the server; already acknowledged audio and text remain saved.

[`deploy/transcription`](../../../deploy/transcription) installs the hash-locked Python dependencies and revision-pinned model under `/srv/pi/.pi-transcription/HASH`, with `/srv/pi/transcription` selecting the prepared tree. It requires `uv` and uses Python 3.12. The model provenance and dependency lock live in [`server/meet/asr`](../server/meet/asr). No transcription API key is used and microphone audio does not leave the selected PiStack host for recognition. The conversational Voice connection still sends audio to its existing provider. `deploy/host` prepares transcription alongside runtime dependencies. `PI_STACK_TRANSCRIPTION_DEST` selects a different runtime for deployment rehearsals and supervisor operation.

Converge's implementation informed the separation between the meeting transcript and the Voice handoff. Its `products/kenan/src/meeting-agent/recall.ts` configures Recall streaming transcription with `use_separate_streams_when_available`; its record store retains speaker-attributed segments. `output-media-page.ts` separately captures unfinished Voice turns, and `handoff-transcript.ts` and `pi-agent.ts` track what each agent session has received. PiStack does not depend on Converge's Recall service, credentials, or work data.

## Adapter contract

[`server/meet/protocol.ts`](../server/meet/protocol.ts) owns room snapshots, signaling messages, and stream kinds. [`web/src/meet/media.ts`](../web/src/meet/media.ts) defines `MeetMediaSource`, which carries a participant, a stream kind, and a MediaStream. `MeetMedia.attach` supplies a participant's audio to Voice without losing the original stream. `detach` removes that participant from the mixer.

[`MeetRoom`](../web/src/meet/room.ts) is the first transport adapter. `publish(kind, stream)` publishes camera, audio, and browser media; `onMedia` delivers each remote participant's labelled streams separately. A connector to another conferencing system supplies the same media contract and consumes the PiStack output streams. No Zoom, Teams, or Google Meet connector is included.

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
| Save a Voice turn | `POST /ROOM/transcript/assistant?participant=HOST_ID`, JSON `{id,text,final,startedAt}` |
| Read saved transcript | `GET /ROOM/transcript`, or `?format=text` for a sentence-labelled download |
| List a thread's meetings | `GET /?sessionId=THREAD_ID` |
| Retry failed recognition | `POST /ROOM/transcript/retry?participant=HOST_ID`; the participant parameter is unnecessary once the room has ended |
| Read a camera snapshot | `GET /ROOM/participants/ID/frame` |
| Start or navigate the shared browser | `POST /ROOM/browser?participant=HOST_ID`, JSON `{url}` |
| Read browser connection or JPEG | `GET /ROOM/browser` or `/ROOM/browser/frame` |

Create and join return `{room, participant}`. Polling is also the participant heartbeat. Messages remain in their recipient's mailbox until acknowledged, so a lost response does not lose an offer. The client uses WebRTC's polite-peer offer-collision handling for simultaneous joins and track changes. Participant IDs address participants within the host's existing private-network trust boundary; they are not a separate login mechanism.

## Ownership and checks

Implementation belongs to `apps/remote/server/meet` and `apps/remote/web/src/meet`. The regular Vite build includes the page, and `deploy/host` publishes its server, assets, and browser dependency with the rest of Pi Remote. Host-specific TURN addresses and Chromium installation belong to host configuration.

`bun test apps/remote/server/meet.test.ts` exercises signaling acknowledgement, recipient isolation, host cleanup during browser startup, and per-person frame deletion. `npm run typecheck --workspace=pi-remote` checks the shared browser and server contracts. A deployed media check should join two clients, check separate camera and PiStack streams, navigate the shared browser, and leave the room. A forced-relay WebRTC connection checks TURN separately from a same-machine direct connection.
