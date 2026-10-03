# Telephone calls

`pi-call` connects a host-owned Vonage telephone number to Pi Stack Voice's `gpt-live-1` through a headless Chromium WebRTC bridge. This is separate from `pi-phone` (Android device control). The host installs an optional `pi-stack-phone.service`; hosts without it acquire no telephone account or public endpoint. `deploy/phone` activates configured services and refuses publication during a live call.

## External context boundary

A call receives only a purpose, approved opening, contact name and explicitly shareable facts. It never imports a thread, memory, private files, credentials, tools, meeting prompt, or agent output. Caller requests cannot invoke a privileged agent. Missing facts become questions for Hara, retained in the private call transcript. An authorized local operator can add one explicitly shareable fact using `pi-call context`. These are deliberately different surfaces: operator reasoning stays private; the brief is content approved for the person answering. Do not put internal reasoning in a brief field.

Kenan introduces himself as an AI assistant. Default incoming calls disclose only that he is Hara's assistant and can take a message; caller ID does not unlock additional context. Spending, account changes and binding commitments are outside call authority. Voice is not given credentials even when talking to Hara.

## Commands

```
pi-call status
pi-call preflight                  # Open/close Voice+WebRTC; never dials
pi-call start --brief /absolute/private/brief.json
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

Configuration fields: `owner`, `publicBaseUrl`, `vonageCredentialFile`, `adminTokenFile`, optional `localPort` (8802), `publicPort` (8803), `voiceUrl` (existing loopback Voice), and `chromium` (installed browser executable). Credential JSON fields are `VONAGE_APPLICATION_ID`, `VONAGE_PRIVATE_KEY`, `VONAGE_SIGNATURE_SECRET`, `VONAGE_FROM_NUMBER`; canonical credential custody stays with the host's secret store. `PI_STACK_PHONE_STATE` must name the person's encrypted state directory. It owns `calls.sqlite3` and its WAL, including approved briefs, destination numbers, transcript fragments, errors and provider/session identifiers. No raw audio is saved.

The local listener hosts owner-authenticated controls and independently token-authenticated browser negotiation. The separate public listener exposes only Vonage callbacks and per-call-token WebSocket audio. Never expose the local listener or Pi Remote. Public callbacks must use POST, signed Vonage HS256 JWTs and matching body hashes. The inline outbound NCCO uses custom authorization for the audio WebSocket. Incoming calls require the Vonage application's answer URL `${publicBaseUrl}/vonage/answer`, POST, signed webhooks enabled, and the number linked to that application. Provider account configuration, number ownership and credit are independent of source deployment and must be checked before claiming a working number.

Audio is 16 kHz signed little-endian PCM, 20 ms packets, with bounded queues and real-time output cadence. WebRTC goes directly from Chromium to the existing Voice API. Call duration defaults to five minutes (maximum thirty), and at most two calls run at once. Provider disconnect, audio failure, owner hangup or the duration limit close both the telephone and billed Voice session. Service restart marks unfinished calls interrupted and retries cleanup, never redials.

```
bun test apps/remote/server/phone
npm run typecheck --workspace=pi-remote
sudo systemctl status pi-stack-phone
sudo journalctl -u pi-stack-phone -n 30 --no-pager
```

The handbook owns the specific service unit, encrypted mount access, public ingress, actual number and account readiness. Keep transcript contents out of public logs and commits. Delete service/config/ingress when retiring calling; preserve encrypted call records and canonical credentials unless their owner requests deletion.
