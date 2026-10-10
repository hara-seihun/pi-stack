# Memory and accountable custody

Working memory is one granted Markdown folder per owner. `PI_KENAN_MEMORY_FOLDER` is an explicit absolute path supplied by the authenticated scope; there is no guessed home or administrator folder. [markdown.ts](src/markdown.ts) requires nonempty canonical `README.md` and `AGENTS.md` pointer files and injects those pointers on each turn. Unset/unavailable folders supply no expanded standing authority. Read only notes relevant to the task and update the owning note before finishing active work.

The folder owns facts, decisions, work, calendar data, stated delegation and steering. Its README links `authority.md`, `work.md`, `calendar.md`, `steering.md` and source records. Authority remains stated, scoped and subject to validity, revocations, spending limits, exclusions and third-party consent; predictions are not grants. Calendar remains data, including exact times/timezones and subscriptions, not an app surface. Existing recurrence/ICS adapters can operate on that data without becoming another memory or UI owner.

## Unified grants

[permissions.ts](../orchestrator/src/permissions.ts) is the core principal/resource/action contract for operations, models, tools, threads, memory and data. Configuration supplies explicit grants and consent, with provenance and validity. Ownership, a name, Unix UID, room membership or operational privilege is not an implied allow. Deny wins. Rooms require the complete verified audience to have read/disclosure grants, and protected subjects must consent to the actual recipients/action. Trusted core configuration and authenticated scope/resource registries supply identities; request bodies cannot self-issue grants.

`memoryService(options)` is exported as `kenan-memory/service`, with `MemoryServiceOptions`, `MemoryAuth`, `MemoryPrincipal` and `MemoryAuthorizer`. It returns an embeddable Node HTTP server; core may attach its request listener. Required options: `store`, `auth`, `enabled`, `authorize`. The `authorize({caller,route,input})` callback runs after credential/session authentication and before every operation, including session issuance and private consultation routes. It returns the unified `PermissionResult<Authorization>` synchronously. The same decision is repeated with `record: {about, obviouslyPrivate?}` for each actual record before read/disclosure reports or mutation. Private consultation roles do not bypass record scopes; absent and inaccessible delete targets receive the same denial. Unset authorization returns 503; denial returns 403 without mutation. The callback maps authenticated callers and trusted resource descriptors through core's actual policy, not caller-selected grants.

Memory HTTP and consultation admission keep their authenticated setting, provenance, privacy, complete audience and log-before-disclose guards. These are additional restrictions, not an alternative grant source. The shared core owns principal authentication and authorization adapters. Raw database handles are custody-only, not public authorization APIs. Standalone custody startup requires `PI_KENAN_MEMORY_AUTHORIZATION_MODULE` exporting `memoryAuthorizer({auth,store})`; shared core embedding is the service owner.

[core/memory.ts](../orchestrator/src/core/memory.ts) adopts the existing database and credential file under a declared confidential custody scope. Its config names `id`, `uid`, `custodyScopeId`, exact database/auth/receipt paths, authenticated identity selectors, resource descriptors and endpoint/operation/action mappings. Registered resource handles prove the same device/inode in the pinned namespace; the old-owner detached receipt and exclusive database lock are required before opening. A missing database/schema never becomes a new ledger. Closing drains accepted handler promises, then releases store, lock and namespace resources. No separate memory engine/listener is needed.

## Adopt existing data without discarding it

[adoption.ts](src/adoption.ts) exports a read-only source snapshot into the granted folder. [memory-adopt.ts](../../scripts/memory-adopt.ts) accepts only `--plan /absolute/root-owned/plan.json`; the plan must be canonical and not group/world writable. It declares the actual principal, PermissionPolicy, source data Resource/path/format/selection and destination memory Resource/path. The function checks source-read and destination-write grants and consent before opening the source. Destinations cannot weaken confidentiality or move a whole store to another owner.

```sh
bun scripts/memory-adopt.ts --help
bun scripts/memory-adopt.ts --plan /etc/pi-stack/memory-adoption.json
```

The plan is a host-owned migration declaration, not a new grant issuance interface. No private export is run as part of source implementation.

- `format: memory` decrypts **every selected life version**, including policies, steering, entity corrections/retractions, source coverage and import receipts; head status and exact provenance are retained. Subject keys stay in custody and never enter Markdown. Memories retain stopped state. Disclosure and consent journal records retain exact bodies and IDs.
- `selection: {kind: person, person: ID}` exports that person's life records and only exclusively tagged memory/disclosure records. Mixed/shared material remains in the original restricted journal. `selection: {kind: whole-store}` is for the original custody owner's restricted folder under an explicit whole-source grant, never a person export shortcut.
- `format: calendar` copies events, subscription bodies/ICS, settings and deletion-undo custody from the declared person's calendar source. This preserves timezone and exact source fields; it does not create events or fetch feeds.
- Content-addressed `.md` records contain exact original values. The source fingerprint manifest links them. Atomic exclusive writes reuse identical records, reject changed content, preserve hand-edited owning notes and pointer files, and publish the receipt last. A failed run leaves source untouched; rerun continues the same snapshot without duplicates.

Adoption never deletes source databases, changes grants, resets effects, reopens stopped work, renews authority or replays uncertain actions. Credential/session material and external-action fences remain with their native owners. Host activation must bind existing sources and accepted custody before retiring any owner.

## Independent action, disclosure and consent custody

[contract.ts](src/contract.ts), [store.ts](src/store.ts) and the authenticated memory service retain the accountability journal. This is not a live life/task ledger. Person tools query their own exclusively tagged facts and nonprivate recipient-relevant actions; broader shared/private facts go through a granted private consultation. Stopped records do not return from searches. Delete/stop-using requires the person's actual choice. Action replay deduplicates by verified person and external ID; forgotten actions retain replay tombstones.

[Person guidance](person.md) keeps each thread transparent. [Private discretion](discretion.md) and [root operations](../kenan-root/README.md) preserve full verified audience, fresh private consultation, exact chosen replies, log-before-disclose, consent questions/answers and restart-safe delivery. Only selected replies cross into ordinary or room conversations, never private context or traces.

[External-action authority](../../docs/action-journal.md) remains the effect owner: canonical business intents, recipient holds, provider evidence and uncertainty reconciliation. The [journal](src/journal.ts) projects supported outgoing actions. Unjournaled sends require an actual-action memory receipt with only recipient-relevant content. Markdown never stands in for a provider receipt or release of an unresolved recipient fence.

## Operation

Source is built with `npm run build --workspace=kenan-memory`; focused fixtures use `bun test packages/kenan-memory/tests/adoption.test.ts` and `packages/orchestrator/tests/permissions.test.ts`. Fixtures use disposable databases only. Installed journal custody remains encrypted under its owning mount, with real gocryptfs admission and no plaintext-directory substitution. Host activation owns folder paths, explicit grants, exact source identities and core wiring; source code does not grant private-folder access or run an export.
