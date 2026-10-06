# Personal watch list

The watch list is a person's persistent collection of things worth checking again. For an agent waiting on workers or durable external work in its own existing conversation, use [thread_wait and thread_wake](threads.md#durable-dependency-waits-and-own-thread-wakes) instead: those preserve the original thread and are independent of the personal check batch floor. Any of that person's normal PiStack agents can maintain it with `watch_list`, `watch_list_add`, `watch_list_update` and `watch_list_remove`. These tools accompany the asynchronous question tool in both Remote and Orchestrator sessions, and are also available to live dispatchers. Raw/sandbox sessions retain their declared restricted tools.

Each item contains `id`, `what`, `why`, optional `how`, optional `cadenceMs`, `nextDueAt`, optional `destination`, `addedBy` (the adding thread ID), `createdAt`, `updatedAt`, and optional `lastThreadId`. Times are Unix epoch milliseconds. A new item defaults to due now; absent cadence uses the person's configured interval. Cadences must be at least one minute. An update preserves omitted fields; `how:null` and `cadenceMs:null` clear those options. Removal deletes the current item, not the checking threads' history.

```json
{
  "what": "Check whether the example service has recovered",
  "why": "Its status determines whether a follow-up is still needed",
  "how": "Read its status endpoint and the owning incident record",
  "cadenceMs": 3600000,
  "nextDueAt": 1790985600000
}
```

## Destinations

An item belongs to the person's destination (for example `personal` or `home`) whose workspace and context should check it. On add it inherits the destination of the adding thread, resolved through its parent chain; a watch check that adds a follow-up inherits the destination it is running in. A thread the person's own supervisor cannot resolve — a fleet-forwarded caller, a deleted thread, a raw or sandbox thread — leaves `destination` absent, which means the default. Add and update accept an explicit `destination` among the person's full-context destinations, so an agent can file or move an item where it belongs; any other value is rejected. An update without one preserves the item's destination. An item naming a destination that is no longer offered is checked in the default.

Items from before destinations are backfilled each time the supervisor starts: the item takes its `addedBy` thread's destination, without changing `updatedAt`. Unresolvable origins stay on the default. A watch check that ran in the default destination counts as a default-destination origin, so a personal follow-up it added before this change stays there until an agent moves it.

Do not seed personal checks into source or configuration. Agents add real items through the tools after release.

## Scheduler and decisions

The person's unlocked Remote supervisor owns the scheduler. It polls due times every 30 seconds without inference. The default repeat cadence and minimum spacing between automatic batches is 45 minutes. The person's configured interval is a floor: shorter item cadences cannot override it, and newly added or retimed items join the next eligible batch. Longer item cadences are preserved. The global next-wake time is durable across supervisor reloads. An empty list, a list with nothing due, or a disabled scheduler makes no model call. Locking the person's encrypted folder stops its supervisor and therefore stops its watch agent too.

A due batch is split by destination, and each destination with eligible items gets its own visible root **Watch list check** thread, pinned to `anthropic/claude-opus-5-5`, high thinking, standard speed. The checks of one batch may run side by side; the interval floor spans the whole batch, and no new batch starts while any watch check is running, including decision continuations. Each check runs in its destination's admitted workspace with that destination's thread metadata, so a Personal check has the private workspace as its cwd and keeps encrypted-folder custody. It also carries the destination's watch context files as `metadata.contextFiles`, the same choice the New chat picker records, so those files arrive whole in its system prompt on every turn. Each check sees only its own destination's due items. It uses ordinary persistent thread execution and its tools; it cannot spawn workers. The scheduler advances selected items' next due time when it durably records the batch's wakes; the agent may change their timing, remove resolved items, or add follow-ups. The check prompt asks the agent to read the live list first, check current evidence, act on routine follow-ups, report unfinished checks plainly, and finish.

Spending money, commitments on the person's behalf, irreversible actions and other consequential decisions go through `request_user_input_async`, not autonomous approval. Its questions remain attached to the checking thread and answers resume that thread through normal human steer delivery. Items from a batch with pending questions do not create another check until those questions are answered; unrelated due items remain eligible. The question UI/notification contract is [asynchronous questions](../apps/remote/docs/questions.md).

The scheduler is not a separate agent runtime. Recovery reconnects through the normal thread service. A pending wake contains an immutable spawn request and stable identity; restart or a lost acknowledgement retries that same request instead of creating another check. Current watch items and mutation receipts are committed atomically. A stale check prompt confers no additional authority.

## Configuration and custody

The person registry's `environment` configures the supervisor:

- `PI_REMOTE_WATCH_ENABLED`: default enabled; set `0` to stop automatic checks while retaining tools and items. Reload the supervisor to apply changes. Disabling does not cancel an already-running check; stop its thread separately if needed.
- `PI_REMOTE_WATCH_INTERVAL_MS`: default `2700000`; an integer of at least `60000`. Sets the default item cadence and the minimum spacing between automatic check batches. Item cadences shorter than this interval are clamped when scheduling; adding or retiming an item cannot bypass the batch limit.
- `PI_REMOTE_WATCH_DESTINATION`: the default destination for items without one; defaults to `home` when offered, otherwise the first offered full-context destination (Converge's `work`). Raw/sandbox destinations are rejected.

Each destination in `PI_REMOTE_THREAD_DESTINATIONS` may set `watchContextFiles`, a list of top-level Markdown names in its `contextDir` that its watch checks load whole. Omitted, a destination with a context folder loads every top-level Markdown file there (the picker's default, without the workspace `AGENTS.md`, which Pi already loads from the cwd). Destinations without `contextDir` load none, and setting the field on one is a startup error. A configured name that later disappears is reported in the check's prompt rather than replaced. Each person's choice names only files in their own destination's folder; a host that wants a lighter or narrower load than the whole folder sets the list in that person's registry.

The existing supervisor `DATA/threads.sqlite3` owns `watch_item`, `watch_request`, `watch_wake` and `watch_schedule` inside the person's encrypted data. There is no host-global watch store, plaintext mirror, cron or separate systemd service. Native check transcripts stay alongside other person-owned threads. The main Orchestrator directory forwards watch operations to its authorized `person` owner; it never stores another copy in the fleet ledger. An unavailable or locked person owner is an explicit tool error, not a reason to store personal items elsewhere. Service shutdown stops the poller before detaching threads and closes the watch connection.

`POST /v1/threads/watch` (or the local `/v1/thread-owner/watch`) accepts `{threadId, action}`. Mutations also require `requestId`; add uses `item`, update uses `id` and `patch`, remove uses `id`. Add/update/remove retries return the original receipt, even after removal. The owner verifies thread provenance at the normal capability boundary. Fleet service forwarding keeps the calling thread ID. The response is a domain `Result` containing `{items}`, `{item}`, or `{removed:true,id}`. Tools derive request identity from their thread and native tool call ID.

Errors appear in Remote's existing operational error store under `watch-list` and in the supervisor journal. Missing model capacity is visible on the ordinary check thread; the scheduler never substitutes a different model.

Implementation: [`watch-list.ts`](../packages/orchestrator/src/threads/watch-list.ts), [`pi-tools.ts`](../packages/orchestrator/src/threads/pi-tools.ts), and the supervisor integration in [`server.ts`](../apps/remote/server/server.ts). Focused acceptance: `npm test --workspace=pi-orchestrator -- tests/watch-list.test.ts`, and from `apps/remote`, `bun test server/thread-context-files.test.ts server/thread-model-defaults.test.ts` for the context choice and its configuration.
