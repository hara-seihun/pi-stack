# Root consultation custody

Root is an integration inside the [shared Pi Stack core](../../docs/core-host.md), not another agent controller or listener process. `createRootIntegration` owns request, consent and notification custody; the core supplies the authenticated scope, existing ThreadService and native in-process runtime. The core clock calls reconciliation. [Custody adoption](../../docs/core-custody.md) preserves encrypted stores, exact request identities, private native histories and resource namespaces.

## Private execution

Configured `consultationScopeId` owns new requests. `consultationOwners` maps retained root-session IDs to their exact prior scoped thread databases. Terminal `reply.json` receipts need no new native session. Accepted queued input resumes only in its registered original owner. An unavailable old owner returns a typed error, never a replacement thread or copied transcript.

Private scopes are absent from ordinary directories unless explicit grants permit access. Admin capability checks remain necessary and are additionally bounded by the core's registered credential and per-scope read/control grants. Files, keys and namespace paths are explicit root-owned configuration; no request supplies these resources. Root's fixed model, prompt and toolset come from its declared configuration, not the caller.

## Admission and reply boundary

`POST /v1/ask` accepts `{request:string}` with the minted person's `x-kenan-memory-session` capability. Memory authenticates person/thread and the current full audience for rooms. A new consultation starts one fresh native session; recovery does not. `root_reply` chooses the sole outgoing text, and exact disclosure accounting must acknowledge before that reply leaves private custody. Native histories and intermediate reasoning are not returned to the requester.

Clients attach `x-kenan-request-id`, a UUID stable for the original tool call. Root commits admission to the encrypted request store before execution and returns `202 {requestId,status:'pending'}`. Repeating the same ID/text retrieves that operation; changed text is rejected. Headerless retained callers use the original synchronous response contract.

`GET /v1/ask/:requestId` checks the same person-session capability, original person/thread and current full room audience. Replies contain only the chosen text or safe lifecycle status, never private native IDs or error details. A valid caller may receive `not-accepted` with `safeToResubmit:true` only after the absent identity has been durably fenced against late admission. Timeouts and lost acknowledgements do not establish nonacceptance.

Queued capacity or resource waits retain the original request identity. Interrupted native execution is not replayed. A persisted chosen reply can retry disclosure finalization without another model. Completed asynchronous replies enter a durable outbox and are delivered through the authenticated router bridge with stable message IDs; each attempt rechecks audience and disclosure accounting. Failed/interrupted requests deliver a fixed operational notice rather than private traces.

## Release and callback transport

`GET /v1/health` retains release and handoff metadata. Authenticated `POST /v1/admin/release` persists a target-bound dispatch pause; accepted work drains naturally, while new asks may remain durably pending. Only the matching authorized target can resume dispatch. The shared core owns shutdown ordering and waits for accepted judgments before closing their stores.

Old native generations may still hold Root/memory URLs. Explicit retained callback listeners expose the same canonical plugins inside the core process, preserving existing auth and route boundaries. A protected detachment receipt binds each former owner and exact port before rebinding. Remove a listener only after its retained consumers have transferred; elapsed time is not proof. The original in-process Root owner must finish active judgments before its service is retired.

## Consent and notifications

`root_request_consent({subject,question})` creates a durable private exchange. Follow the [question authoring rule](../../apps/remote/docs/questions.md#authoring): ask permission for the exact disclosure first, retaining only answer-changing context. The service appends authenticated requester/full audience and private-return context, logs the exact question and calls the narrow router consent bridge. Only an acknowledged receipt means the subject was asked.

Answers are read from the owning thread's durable question receipt, matched to the exact question and logged privately. Resumption preserves person/thread/audience and obtains the authorized memory capability. The resulting judgment selects and accounts for its reply before stable-ID delivery. Raw subject answers and Root traces never travel to the requester. Held threads remain held.

`root_notify({recipient,text,subjects,obviouslyPrivate})` commits exact recipient/text custody before returning queued. Queued is not delivered: only acknowledged delivery settles the outbox. Exact disclosure/action accounting precedes sending. Restarts and lost acknowledgements retry the same chosen message, not a fresh model decision.

Memory-root, Root-admin and consent credentials have distinct authority. Configuration stores file references, never values. Shared process ownership does not merge these grants.

## Focused proofs

`packages/kenan-root/tests` covers fixed resources, reply/admin boundaries, durable request recovery, consent/notification delivery, lost acknowledgements and interrupted-execution nonreplay. `packages/orchestrator/tests/core-custody.test.ts` and `core-callback-transports.test.ts` cover scoped runtime adoption and retained transport boundaries. Live cutover evidence belongs to the host adoption receipts, not these disposable tests.
