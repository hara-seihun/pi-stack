# Reading messages aloud

Long-press (touch) or right-click any message in a chat, human or agent, and choose **Speak**. A reader bar appears at the top of the window with play/pause, stop, the playback speed and the voice. Speed cycles through 0.75× to 2.5× and is remembered on the device; pitch is preserved, so a faster read still sounds like the narrator. The chosen voice is remembered per engine. The phone's lock-screen media controls drive the same player.

Audio starts within about a second of choosing Speak and keeps arriving while the engine is still speaking the rest, so a long message does not wait for its own synthesis. Reading faster than the engine synthesizes (Fish runs at roughly 1.3× real time in single-take mode) makes the player wait for more audio now and then; nothing is lost.

## Engines are plugins

The supervisor reads `PI_REMOTE_SPEECH` from the person's registry environment:

```json
"PI_REMOTE_SPEECH": {
  "engines": [
    { "id": "fish", "plugin": "fish-speech", "name": "Fish Speech", "options": { "url": "http://127.0.0.1:5174", "defaultVoice": "audiobook" } }
  ]
}
```

The first engine is the default. A host with no `PI_REMOTE_SPEECH` reads nothing aloud: the bootstrap's `speech` is `null` and the clients hide Speak. A configuration error stops the supervisor at startup with the offending field named.

A plugin is a module under [`server/speech/`](../server/speech/) exporting a `TtsPluginFactory` registered in `SPEECH_PLUGINS` in [`service.ts`](../server/speech/service.ts). The [`TtsPlugin`](../server/speech/plugin.ts) contract is small: `voices()` lists the catalog, `speak({ text, voice, signal })` accepts one segment and resolves to a stream of signed 16-bit mono PCM chunks plus their sample rate, and `maxSegmentChars` says how much text one call may take. The service owns everything else: converting Markdown to spoken words, splitting long messages on line breaks, ordering the takes, encoding to Ogg/Opus with ffmpeg and serving the HTTP routes.

### Text preparation and segmentation

[`text.ts`](../server/speech/text.ts) turns a Markdown message into words: headings, emphasis, links, lists, tables and inline code become their text; fenced code blocks become "Code omitted."; `<pi-remote-file>` and `<pi-remote-image>` tags disappear. Line breaks survive.

If the prepared text exceeds the engine's `maxSegmentChars`, it is split on line breaks: consecutive lines are merged into one take while they fit, a line is never split across takes, and only a single line longer than the limit is cut, at sentence boundaries and then at words. Takes are spoken in order; the next take is requested as soon as the previous one's audio has fully arrived, so the engine sees one request at a time per utterance.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /v1/speech` | Configured engines and their default voices (also in the stream's `bootstrap.speech`). |
| `GET /v1/speech/engines/:engineId/voices` | The engine's voice catalog. |
| `POST /v1/speech/utterances` `{ text, engine?, voice? }` | Registers a text to read; answers `201` with the utterance id, its take count and character count. Utterances expire after 15 minutes. |
| `GET /v1/speech/utterances/:utteranceId/audio` | Chunked `audio/ogg` (Opus, 64 kb/s) produced as the engine speaks. The client points an `<audio>` element at this URL with the session in its query, so playback rate, pause and lock-screen controls are the browser's. An engine failure before any audio answers with JSON and the engine's message; a failure mid-stream ends the stream and the status route says why. |
| `GET /v1/speech/utterances/:utteranceId` | `state` (`ready`, `speaking`, `spoken`, `failed`) and `error`. |

Closing the player aborts the engine request; a supervisor handover aborts every playback.

## Fish Speech

[`fish-speech.ts`](../server/speech/fish-speech.ts) talks to a voice daemon with two routes: `GET /voices` returns `{ voices: { id: { description } } }`, and `POST /speak` with `{ text, voice, direction?, language? }` answers `200 audio/pcm` with `X-Sample-Rate`, `X-Channels: 1` and `X-Sample-Format: s16le` headers and chunked PCM as the model decodes. Options: `url` (required), `defaultVoice`, `maxSegmentChars` (default 700, which keeps a continuous take well inside Fish's 8K-token context), `direction` (a short Fish style tag) and `language` (`en` or `fr`).

A host can use EverythingLIVE's resident Fish S2 Pro worker; its streaming route, voice catalog and in-process voice import are documented with that project. One configured `audiobook` voice is Bob Neufeld reading Edith Wharton's *Ethan Frome* for LibriVox (public domain). The voice excerpt and provenance belong in the host's voice store.
