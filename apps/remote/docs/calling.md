# Telephone calls

`pi-call` connects an owned Retell-managed PSTN number to **GPT Live 1 voice and the existing managed Kenan ThreadService intelligence**. Retell supplies telephony and the monitor/takeover WebRTC transport, not the conversational agent. A pinned custom-LLM endpoint is deterministic and silent: no model runs there. After the phone answers, the browser joins its monitor session, permanently takes over, and publishes GPT Live's native audio. The approved opening waits until publication succeeds. Failure ends the call rather than switching to a provider-hosted brain.

## Authority and records

The approved brief has a durable UUID `requestId`, destination, immutable purpose, approved opening, recipient-safe facts and explicit 60–1800-second bound. Retrying an identity returns its stored call; changing its brief returns a conflict. Dial intent is committed before the one irreversible provider request. An uncertain acceptance is retained and never redialled. Provider duration caps contain acceptance whose response was lost.

A new brief may include optional `followUpOf`, the UUID `callId` of the latest accepted dial to that destination within two hours (not its `requestId` or provider ID). This acknowledges the earlier contact; it does **not** alone override the cooldown. The service additionally requires explicit manager/operator reconciliation approval before allowing a follow-up during cooldown. A recipient hold or any unfinished call still prevents dialing; `followUpOf` bypasses neither. Inspect `pi-call show CALL_ID` and reconcile the prior outcome before approving another contact. Keep the authored purpose, opening and shareable facts intact; a follow-up is a new approved brief with a new `requestId`.

Contact admission is synchronous with reservation, before asynchronous media/provider work. Distinct requests to an unfinished recipient receive `409 recipient-busy`. Accepted dials count as contact even when media subsequently fails; `accepted_at` owns the two-hour clock (older records use their retained start time). Uncertain dial acceptance requires effect reconciliation, not a fresh identity. Repeating an already accepted `requestId` retrieves it without dialing.

Optional `holdsFile` is a live-read JSON map of E.164 number to nonempty reason; `409 recipient-held` returns that reason. Optional `followUpApprovalsFile` is a root-owned regular JSON file, not writable by group/others, keyed by the **new** brief's request ID. Each entry is `{ "followUpOf": "PRIOR_CALL_UUID", "to": "+15555550123", "reconciledAt": 1791597600000, "reason": "Operator reconciled prior effects and approved this follow-up" }`. A manager/operator records approval only after inspecting the prior outcome; calling workers must not create approvals or alter holds. Approval must match the latest accepted call, its recipient and new request, and its reconciliation timestamp must follow the prior end time. Cleanup must be complete. Neither approval nor a brief can override a hold or an unfinished call. Absent config keys mean no file policy/no override grant; configured unreadable, unsafe or malformed files fail closed with `503 contact-policy-unavailable`. Policy reads do not cache holds across calls.

Telephone dispatch also passes through the canonical owner's `/v1/external-actions` authority at `dispatcherUrl`, authenticated by its owned phone capability. Only that supervisor opens the shared encrypted `.kenan-actions/actions.sqlite3`; separate namespace mount paths never create competing stores. A failed or ambiguous authority receipt prevents provider dispatch. The service derives a canonical purpose key, excludes attempt `requestId`/`followUpOf` from the payload identity, and shares recipient slots with other transports. Changed wording or a new thread/request cannot contact an unresolved recipient. It claims before preparation and enters a fenced dispatch immediately before Retell's create request, after provider verification and a fresh hold check. Accepted PSTN is a successful external effect, not a resolved business purpose; even a later media failure does not release its slot. Explicit root-file follow-up approval uses the gateway's atomic prior-effect transition rather than bypassing it. Recent accepted and uncertain retained calls are imported without dialing. Persisted tickets recover to known accepted/rejected/uncertain outcomes; an orphaned claim without a Phone projection remains fenced for explicit sender-retirement reconciliation, never automatic replay. Preflight claims no external action.

The callee is external conversation data, never an authenticated operator. Ordinary appointment and errand cooperation within the approved purpose is allowed. Corrections, options and booking confirmations stay conversational; they cannot grant host access, replace the purpose, or change disclosure rules. Telephone reasoning uses the same managed Pi runner as other Kenan threads, but its immutable `telephoneContext` raw subtype has **zero tools**, no person memory, private system prompt, AGENTS files, skills, extensions or thread-operation capabilities. The application supplies the fixed approved system instructions, while transcripts arrive separately as data. The runtime asserts the empty tool manifest and blocks tool calls. The callee receives neither service tokens nor private internal context.

Call briefs, transcripts, provider snapshots, delegation identities and results live in the owner's encrypted `PI_STACK_PHONE_STATE/calls.sqlite3`. Managed backend threads/transcripts remain in the person's encrypted Remote ThreadService store, not the fleet daemon's application ledger. No raw audio or transcript is logged publicly. Existing call records are preserved in place, including earlier provider snapshots. Pending cleanup of retired accounts belongs to those account owners.

GPT Live client delegation accumulates input/output transcript fragments, deduplicates event and delegation IDs, queues managed backend requests with stable identities, and returns concise recipient-facing results correlated to the original Live delegation. Interrupting speech does not promote the callee's authority. Owner hangup, duration expiry, media disconnect, service stop and restart all cancel/close managed reasoning, the browser and Voice/PSTN sessions. Restart interrupts retained calls without redialling.

## Commands

```
pi-call status
pi-call preflight             # GPT audio only; never a PSTN dial
pi-call start --brief /absolute/private/brief.json
pi-call list
pi-call show CALL_ID
pi-call end CALL_ID
```

Example approved brief:

```json
{"requestId":"4208e41f-cafe-4bc5-991f-02dcb8f0f723","to":"+15555550123","contactName":"Alex","purpose":"Confirm the appointment time.","shareableFacts":["Available Tuesday afternoon."],"opening":"Hello, I'm Kenan, an AI assistant calling to confirm the appointment time.","maxSeconds":300}
```

Acceptance is not handset delivery. `show` contains the actual lifecycle, encrypted transcript and provider state. Preflight is not a telephone test. Real outgoing tests require the owner's specific approved intent.

## Host transition

Configuration requires explicit `owner`, `pstnProvider:"retell-takeover"` (or `null` while disabled), `callingEnabled`, `retellCredentialFile`, `silentTokenFile`, `adminTokenFile`, `publicBaseUrl`, loopback `localPort`/`publicPort`, `voiceUrl`, `dispatcherUrl` (the owner's Remote listener) and installed `chromium`. Credential/capability files remain owner-only; the silent transport capability is distinct from owner authorization. The credential shape is owned by `server/phone/retell-transport.ts`; it pins the owned caller number and published silent custom-LLM agent version. Before dialing, live provider metadata must match the exact silent callback URL, immutable published agent, disabled backchannels/reminders, no contact memory, no ambient sound, and retained owned number.

Expose only `publicBaseUrl/retell/silent/CAPABILITY/CALL_ID` to the public telephone listener with WebSocket passthrough. Retell's custom-LLM URL is `publicBaseUrl/retell/silent/CAPABILITY` (WSS); Retell appends its call ID. The capability never enters source or documentation. The silent endpoint returns only empty completed responses and ping acknowledgments. It never receives private context or invokes an agent. Retell calls use an outbound agent override, so number routing need not change. Incoming routing is not configured by this product.

The local listener serves token-scoped media grants and owner-authenticated controls. Monitor access tokens are per call; the API key never enters the browser. Takeover verifies the exact owned provider call and monitor participant. LiveKit grants use their supplied signaling URL; gateway grants use Retell's WebRTC signaling endpoint and route receiver audio through the GPT input gate, with SDK playback muted. Both transports withhold the approved opening until permanent takeover succeeds. Teardown closes the browser-owned media session before reconciling Retell's terminal snapshot, including `call_take_over`.

`deploy/phone --check` validates config and refuses an active call. Activation follows the optional telephone unit's personal supervisor binding: it never unlocks state or retrieves keys. Remote's media build bundles the pinned Retell Web SDK into the immutable release. Source deployment alone does not provision the silent agent, ingress, number or credentials. Hosts without this owner's telephone service receive implementation only.

The host handbook owns actual account/number custody and activation. Preserve encrypted records and canonical credentials; service/transport retirement does not delete them.

## Policy sources and local proof

The authorized GPT Live delegation policy follows OpenAI's [Delegation and tools in GPT-Live](https://developers.openai.com/api/docs/guides/live-delegation) and [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting), read October 8, 2026. It keeps the official Backchannel, Interruption and Delegation headings, separates frontend conversation from backend procedures, and enforces permissions in the application rather than treating speech as authority.

Transport references: [Retell live monitoring/takeover](https://docs.retellai.com/features/live-monitoring.md), [custom LLM WebSocket](https://docs.retellai.com/api-references/llm-websocket), and the pinned SDK's monitor-session/control implementation.

```
bun test apps/remote/server/phone
npm run build:phone-media --workspace=pi-remote
```

Mock tests cannot establish PSTN delivery. They cover silent transport protocol, provider validation, approved identity nonreplay, callee authority, and media takeover/cleanup without outgoing calls.
