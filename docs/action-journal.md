# External action authority and receipt journal

`packages/kenan-memory/src/actions.ts` owns dispatch decisions; `journal.ts` projects actual attempts/outcomes into recipient-relevant memory. Transport databases project canonical action IDs and provider evidence, not competing dispatch permission. The authority is mandatory for the covered transports even when `oneKenan` disables memory capture.

## One canonical owner, across workers and hosts

The person's canonical manager environment owns `.kenan-actions/actions.sqlite3` inside their encrypted folder, opened by their supervisor. `/v1/external-actions` uses existing owner/thread authentication and the owned telephone capability. It never accepts owner identity from the request. The router identifies the local Unix account and pins routing to its host-configured, account-granted canonical manager environment. Another host cannot choose a second ledger or an arbitrary person. Missing canonical custody returns a typed error, never a local fallback.

Telephone and mail use the synchronous `ActionClient` to that supervisor; Signal uses its injected authority inside the supervisor. A noncanonical Signal supervisor proxies to the canonical host through the separate account router. Native agent tools use asynchronous HTTP so a same-process supervisor call cannot deadlock. Separate encrypted mount namespaces never independently open competing SQLite dispatch authorities. `PI_ACTION_AUTHORITY_LOCAL_FIXTURE=1` permits an isolated local store for synthetic tests; it is not a production transport mode.

Tables live in the existing private action-journal boundary: actions, request aliases, recipient slots/holds/verified aliases, one-shot dispatch entries and accountable transition events. SQLite immediate transactions, WAL, FULL synchronization and a busy timeout cover concurrent processes and restart custody. The database is owner-only. No personal records or credentials belong in public source.

## Canonical intent and recipient coordination

The stable identity is owner + canonical business intent + recipient identity set, not worker/thread/request UUID. Payloads are canonical finite JSON; volatile transport UUIDs, generated mail Date/Message-ID and similar retry metadata do not enter them. Changed payload under the same intent/request is a conflict, not permission to resend.

Only an exact canonical intent, recipient set, transport and payload retry returns the existing action/status/result. A differing submission to an unresolved recipient returns `ok:false` (`fenced`, or `payload-conflict` for a changed existing intent/request), with the prior action and `blocked by unresolved prior action <id> to <recipient>; resolve-purpose it to continue`. No new request alias or dispatch is created; a prior success receipt inside a refusal is evidence, not success for the new content. The same refusal applies to mail, Signal, telephone and browser. A confirmed send does not by itself finish the business purpose. Provider-verified Signal aliases are linked transactionally to phone identities; an earlier ACI contact then fences a later phone call. Discovering two conflicting unresolved alias contacts holds both rather than silently merging effects. Unknown aliases cannot be identified by guessing.

A new intended effect or substantive followup is possible through an accountable exact-revision transition: `followup` atomically resolves a reconciled prior purpose and reserves its successor, with gateway-owned lineage. `retry` reopens only a positively proved `failed-before-effect` action and reacquires recipient slots. Existing recipient holds remain binding. No per-action human approval queue is introduced; managing/owning actors act within existing authority. An authenticated submitting worker may `resolve-purpose` its own `succeeded` action at its exact revision, with accountable evidence. The endpoint binds `submittingThreadId` on first creation from verified thread authentication; retries never transfer ownership. Historical actions and process/transport-only submissions have null thread ownership, never inferred from actor text. Native mail/browser submissions and canonical Signal submissions carry verified worker ownership; Signal CLI forwards its thread capability. A noncanonical Signal service proxy remains transport-owned unless an exact native worker reservation already exists; raw cross-host thread text grants nothing. Other reconciliation decisions, recovery, retry, followup and hold release require the authenticated managing thread, owning operator or granted transport owner. Uncertain or active effects cannot be resolved by a worker; actor/evidence text does not confer authority. Telephone additionally keeps its root-owned approved-followup and local hold/cooldown boundary.

## States and provider ambiguity

| State | Meaning | Dispatch |
|---|---|---|
| `accepted` | Durable intent; no worker has claimed this generation | One atomic claim may win |
| `inflight` | Worker claimed; may be preparing or already dispatched | No second claim; no expiry/restart replay |
| `succeeded` | Provider positively accepted the effect | Never replay; business purpose remains held |
| `failed-before-effect` | Affirmative local pre-dispatch or provider rejection evidence proves no effect | Only explicit evidenced retry |
| `uncertain` | Provider acceptance cannot be established or excluded | Fenced pending reconciliation |
| `held` | Explicit recipient/purpose hold before dispatch | No dispatch |

Claim commits before asynchronous preparation. `dispatch(ticket)` is a second, one-shot generation fence immediately before provider mutation and rechecks holds added during preparation. Reusing even the same ticket cannot dispatch twice. A crash after provider send before the receipt remains `inflight`; the transport owner can retire the known sender into `uncertain`, never straight into replay. An orphan between authority claim and transport projection also remains fenced for explicit owner recovery.

`effect-confirmed` needs a provider receipt. `no-effect-confirmed` needs affirmative rejection/no-effect proof, not a timeout, missing log or elapsed time. Evidence is an accountable assertion by the authorized reconciler; the generic mechanism does not independently query arbitrary providers. A stale token/revision cannot finish or reconcile another generation. External providers without idempotent APIs do not become exactly-once: this mechanism enforces at-most-once dispatch per fenced generation and retains uncertainty instead of duplicating the effect.

## Covered outbound boundaries

- [Telephone](../apps/remote/docs/calling.md): `pi-call`/owned service, Retell dial after preparation, local holds/exclusivity/cooldown and root-approved followups. Provider acceptance is contact even if later media fails. Recent accepted and all uncertain retained calls are adopted without dialing.
- [Mail](../tools/mail-send/README.md): `pi-mail-send` and installed owned `mail-send` route, parsed To/Cc recipients, stable MIME content, deterministic Message-ID, SMTP partial acceptance/rejection/unknown outcomes. The canonical supervisor owns permission, not the CLI's mount namespace.
- [Signal](../apps/remote/server/messaging/README.md): `pi-signal`/agent-signal HTTP service text, attachments, groups, quotes, reactions/removals; existing request/outbox receipts and historical unknown effects are adopted without sending. The canonical store is explicitly injected; missing authority refuses mutation.
- [Browser](../packages/runtime/extensions/browser/README.md): declared single-operation effects and narrowly classified effect commands require canonical reservation, claim and one-shot dispatch before native execution. Undeclared classified effects are refused, including recursive script commands. Ordinary reads remain usable. A browser gesture is retained as uncertain until provider evidence, not treated as a confirmed effect.
- [Raw outbound entrypoints](../tools/raw-outbound-guard/README.md): supported Signal launcher/JSON-RPC and msmtp dispatch paths are refused outside the canonical adapters; the managed agent `sendmail` route is guarded. Diagnostic/read commands remain usable. Canonical Signal supervision selects the root-declared retained provider executable. First installation is a provider-selection cutover: an older Signal generation cannot be restarted safely without the owning rollback restoring executable selection and msmtp diversion.

## Agent API and CLI

Native tools: `action_inspect`, `action_submit`, `action_reconcile`; `pi-actions` is the agent CLI. They use the person's authenticated canonical supervisor. `action_submit` reserves an intent; it does **not** send. An owned transport may atomically claim an exact existing accepted intent; other states or a typed refusal do not dispatch. Use the transport's documented canonical payload/intent shape rather than an unrelated reservation.

```sh
bun /srv/pi/runtime/node_modules/kenan-memory/src/actions-cli.ts --help
printf '%s' '{"id":"ACTION_ID"}' | bun /srv/pi/runtime/node_modules/kenan-memory/src/actions-cli.ts inspect
```

CLI operations: submit, inspect/list, claim, dispatch, finish, reconcile, recover, retry, followup, hold/release-recipient and link-recipients. JSON stdin and typed JSON results preserve request identity after ambiguous acknowledgements. Credentials never travel in process arguments. `PI_KENAN_ACTION_CLI` selects the mail helper source for fixtures; production uses the deployed immutable runtime.

## Receipt projection

Memory capture remains gated by `oneKenan`. Every journal attempt is fsync-written before its covered effect; outcome-write failure does not turn a successful send into permission to retry. The authority remains canonical even if journal delivery is unavailable. Journal receipts are `MemoryInput` with owner, recipients/affected subjects, thread/room where known, occurrence time, stable external ID and compact summary. Explicit private marking and conservative keywords assist privacy classification; they do not replace disclosure judgment.

Ordinary-UID journals use their private mount's `.kenan-actions`; root services use their configured encrypted shared spool. Directories are 0700, receipts 0600. The durable journal drain transfers only settled memory receipts, not dispatch decisions. It scans mounted registered folders, never creates a spool beneath an unmounted encrypted folder, and deletes a receipt only after memory acknowledgement. Publisher credentials are write-only and are never in receipts or process arguments. Forgotten action receipts retain hashed replay tombstones so draining cannot resurrect them.

Other journaled boundaries remain receipt-only: Android `sms.send`/dial/calendar/notification reply, calendar mutations, PiStack publication and room posts. Their existing durable native request mechanisms are unchanged by this first authority delivery.

## Exact limits

This is an enforced supported-entrypoint boundary, not a voluntary ledger or universal interception of administrator shell effects. Browser opaque CSS/@ref clicks, other/localized labels, autosubmitting fill/check/select/keypress, eval/DOM code, opaque script operations, navigation/GET effects, timers/workers/popups, profile startup/extensions, Electron and raw CLI/CDP remain uncovered. One fenced gesture can itself issue multiple provider requests; at-most-once native invocation is not exactly-once page semantics.

Credential/UID bypasses remain: retained Signal/msmtp provider executables, Java/JAR and same-UID Signal keys, absolute Postfix `/usr/sbin/sendmail` and its submission/queue services, direct SMTP via the Bridge credential, direct provider HTTP APIs and sudo. Guarded PATH routes do not isolate those capabilities. Genuine universal credential enforcement would require a separate UID/credential broker. Android phone/SMS/notification commands, unrelated calendar/room/publication/admin mutations and existing receipt-only journals are outside this business-intent authority. Unknown recipient aliases remain unknown until verified. The linked browser and raw transport owners enumerate these boundaries exactly.

## Source and synthetic acceptance

```sh
bun test packages/kenan-memory/tests/actions.test.ts apps/remote/server/external-actions.test.ts packages/orchestrator/tests/agent-tool-schemas.test.ts
bun test apps/remote/server/phone/action-admission.test.ts apps/remote/server/phone/service.test.ts apps/remote/server/messaging/service.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 tools/mail-send/test_send.py
```

Fixtures use synthetic owners/recipients, temporary private stores, loopback mock providers and real authority clients. They cover process concurrency, same intent/new IDs, rephrased contacts, payload conflicts, held recipients, crash-after-send-before-receipt, uncertainty reconciliation, alias discovery/conflicts, exact revision followup, canonical host routing and owner isolation. No real recipient is contacted. [Installed synthetic acceptance](../tools/external-actions/README.md) imports selected code, checks Remote/runtime markers and makes a fresh nonexistent-ID read-only route probe; it never mutates live action state. [Publication](deployment.md) owns independent release evidence and both-host delivery; a source test is not an installed claim.
