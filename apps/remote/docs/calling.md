# Telephone calls

`pi-call` connects a host-owned Vonage or SignalWire number, or an explicitly provisioned physical SIM audio gateway to Pi Stack Voice's `gpt-live-1` through a headless Chromium WebRTC bridge. This is separate from `pi-phone` (Android device control). The host installs an optional `pi-stack-phone.service`; hosts without it acquire no telephone account or public endpoint. `deploy/phone` validates the selected provider configuration before activation and refuses publication during a live call.

## External context boundary

A call receives only a purpose, approved opening, contact name and explicitly shareable facts. It never imports a thread, memory, private files, credentials, tools, meeting prompt, or agent output. Caller requests cannot invoke a privileged agent. Missing facts become questions for Hara, retained in the private call transcript. An authorized local operator can add one explicitly shareable fact using `pi-call context`. These are deliberately different surfaces: operator reasoning stays private; the brief is content approved for the person answering. Do not put internal reasoning in a brief field.

Kenan introduces himself as an AI assistant. Default incoming calls disclose only that he is Hara's assistant and can take a message; caller ID does not unlock additional context. Spending, account changes and binding commitments are outside call authority. Voice is not given credentials even when talking to Hara.

## Commands

```
pi-call status
pi-call preflight                  # Open/close Voice+WebRTC; never dials
pi-call start --brief /absolute/private/brief.json
pi-call gateways
pi-call start --gateway hara-sim --brief /absolute/private/brief.json
pi-call list
pi-call show CALL_ID
pi-call context CALL_ID --fact /absolute/private/shareable-fact.txt
pi-call end CALL_ID
```

Example brief:

```json
{"to":"+15555550123","contactName":"Alex","purpose":"Confirm the appointment time.","shareableFacts":["Hara is available Tuesday afternoon."],"opening":"Hi, I'm Kenan, Hara's AI assistant. I'm calling to confirm the appointment time.","maxSeconds":300}
```

The CLI reads `/etc/pi-stack/phone.json` (`PI_STACK_PHONE_CONFIG` overrides it), then the owner-only admin token file. Ordinary accounts do not inherit this token or the phone credentials. `start` returns accepted/preparing, not successful delivery. `show` gives the provider status, error and GPT Live transcript fragments. An unanswered call, API rejection, audio failure, and a completed conversation are distinct outcomes. No uncertain dial is automatically replayed.

## Host operations

Configuration fields: `owner`, explicit `pstnProvider` (`"vonage"`, `"signalwire"`, or `null` for SIM-only), optional `simGateways` (see below), `callingEnabled` (false until provider credit and number ownership are confirmed), `publicBaseUrl`, the selected provider's `vonageCredentialFile` or `signalwireCredentialFile`, `adminTokenFile`, optional `localPort` (8802), `publicPort` (8803), `voiceUrl` (existing loopback Voice), and `chromium` (installed browser executable). Unset/unknown selection fails startup, rather than choosing a provider or silently falling back to another line. Existing Vonage installations must add `"pstnProvider":"vonage"` before activating this release. Vonage credential JSON fields remain `VONAGE_APPLICATION_ID`, `VONAGE_PRIVATE_KEY`, `VONAGE_SIGNATURE_SECRET`, `VONAGE_FROM_NUMBER`.

SignalWire credential JSON contains exactly these fields, stored in a host-only private file:

```json
{
  "SIGNALWIRE_SPACE_URL": "https://your-space.signalwire.com",
  "SIGNALWIRE_PROJECT_ID": "your-project-id",
  "SIGNALWIRE_API_TOKEN": "your-voice-scoped-api-token",
  "SIGNALWIRE_SIGNING_KEY": "your-project-webhook-signing-key",
  "SIGNALWIRE_FROM_NUMBER": "+15555550100"
}
```

The signing key comes from the project's API Credentials page and is separate from the API token. The space URL is an HTTPS origin, not an arbitrary API proxy. Canonical credential custody stays with the host's secret store; source publication does not provision or transfer credentials. Keep both provider credential paths and the callback base during a provider cutover until retained calls finish cleanup: stored calls record their original provider, so a SignalWire selection never hangs up an old Vonage call through the wrong API.

`PI_STACK_PHONE_STATE` must name the person's encrypted state directory. It owns `calls.sqlite3` and its WAL, including approved briefs, destination numbers, transcript fragments, errors, provider kind, single-shot dial state and provider/session identifiers. Existing PSTN records with provider IDs migrate as Vonage. No raw audio is saved.

The local listener hosts owner-authenticated controls and independently token-authenticated browser negotiation. The separate public listener exposes only provider callbacks, per-call-token WebSocket audio and device-token-authenticated `/gateway/connect`. Never expose the local listener or Pi Remote. Vonage public callbacks must use POST, signed HS256 JWTs and matching body hashes. The inline outbound NCCO uses custom authorization for the audio WebSocket. Incoming calls require the Vonage application's answer URL `${publicBaseUrl}/vonage/answer`, POST, signed webhooks enabled, and the number linked to that application. Provider account configuration, number ownership and credit are independent of source deployment and must be checked before claiming a working number.

SignalWire uses the Compatibility API (`/api/laml/2010-04-01/Accounts/PROJECT/Calls.json`), project/API-token Basic authentication, and inline `<Connect><Stream codec="PCMU@8000h" realtime="true">` cXML. Calls subscribe to initiated/ringing/answered/completed POST status callbacks at `${publicBaseUrl}/signalwire/events/CALL_ID`. Inbound number configuration must use cXML with `${publicBaseUrl}/signalwire/answer`, POST, and may set the status URL `${publicBaseUrl}/signalwire/events`. Expose exactly these HTTP routes and `/signalwire/media` for WebSocket upgrade, preserving Authorization. HTTP callbacks require `X-SignalWire-Signature`: HMAC-SHA1 of the configured external URL plus sorted, decoded form fields using the project signing key. Signature verification uses the configured public URL, never forwarded Host headers. Wrong/missing signatures, account IDs or owned call IDs reject with 403.

The documented SignalWire Stream handshake carries `Authorization: Bearer ...` from the per-call `authBearerToken`; it does not advertise an HTTP webhook signature. Missing/wrong/consumed bearer tokens reject with 403 **before** WebSocket upgrade, including while calling is disabled. Once authenticated, connected/start messages must pin the call/stream identity and announce mono mulaw8k before any audio flows. Duplicate starts, invalid packets, unsupported codecs and stream failures close the call. Provider account provisioning, funding and a real approved handset call remain separate host operations; offline tests never dial.

Voice and Vonage audio are 16 kHz signed little-endian PCM, 20 ms packets, with bounded queues and real-time output cadence. SignalWire JSON media carries base64 G.711 mu-law at 8 kHz; stateful low-pass resampling bridges it to the same 16 kHz PCM Voice transport and emits 160-byte/20 ms provider packets. WebRTC goes directly from Chromium to the existing Voice API. Call duration defaults to five minutes (maximum thirty), and at most two calls run at once. Provider disconnect, audio failure, owner hangup or the duration limit close both the telephone and billed Voice session. Service restart marks unfinished calls interrupted and retries cleanup by their stored provider, never redials. Dial intent is persisted before the one API dispatch. Network failure, timeout, server error or a successful response without a call ID is explicitly uncertain, not a rejected call or permission to retry. Such a record retains pending cleanup; a signed late callback can recover its call ID and hang it up, including after restart. Callbacks for ended calls cannot recreate audio or Voice sessions.

```
bun test apps/remote/server/phone
npm run typecheck --workspace=pi-remote
sudo systemctl status pi-stack-phone
sudo journalctl -u pi-stack-phone -n 30 --no-pager
```

## Physical SIM audio gateway

Android call-control APIs can request cellular calls, but ordinary apps cannot capture the SIM downlink or inject its uplink. Phone permission alone does not provide a GPT audio bridge. The no-root route is a Bluetooth HFP hands-free accessory beside the phone: original ESP32-WROOM-32/32E, Wi-Fi, USB power and [the pinned firmware](../../sim-gateway/firmware/README.md). ESP32-S3/C3 do not provide the required Classic Bluetooth. No nearby computer is required at runtime; initial flashing still needs a USB host or a preflashed board. Hardware pairing and real duplex calling have to be tested on an actual board before claiming this transport works.

Provision `simGateways: [{"id":"hara-sim","name":"Hara SIM bridge","tokenFile":"/absolute/private/device-token"}]` in host configuration. Each token is unique, at least 32 characters, and separate from the admin token. Copy only this device token to private firmware provisioning; never give the board owner/API credentials. Set `"pstnProvider":null` for SIM-only installations; both PSTN credential paths and `publicBaseUrl` can then be omitted. `callingEnabled` gates the selected PSTN provider, not independently provisioned SIM gateways.

Expose exactly `/gateway/connect` on the public listener as a WebSocket with Authorization passthrough. The device authenticates by HTTP Bearer token, then announces `hello` with its configured ID, `sampleRate:16000`, and Bluetooth readiness. Heartbeats run every 15 seconds; 45 seconds of silence disconnects the gateway and ends its owned call. Control packets are bounded JSON; audio is exactly 640 bytes of PCM16le per 20 ms frame. Server operations are `dial` and `hangup` with an owned UUID. Firmware reports `call-state`; `active` means both the owned call and its SCO audio are connected. No incoming SIM call is automatically answered.

`start --gateway ID --brief FILE` checks live readiness before allocating Voice or dialing. No ready device means HTTP409, not a fallback phone call. Audio stays closed until the owned call becomes active, closes immediately on hangup, and cannot reopen through late state events. A dial dispatch is single-shot: disconnects, uncertain sends and service restarts never replay it. A hangup keeps the modem reserved until firmware confirms completion or disconnects; firmware owns a local maximum-duration and disconnected-server watchdog. Call records retain `gateway_id` alongside the same private brief/transcript boundary used for Vonage. No real call is made by gateway tests.

The handbook owns the specific service unit, encrypted mount access, public ingress, actual number and account readiness. Keep transcript contents out of public logs and commits. Delete service/config/ingress when retiring calling; preserve encrypted call records and canonical credentials unless their owner requests deletion.
