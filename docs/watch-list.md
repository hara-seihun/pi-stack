# Personal watch list

The watch list is a person's persistent collection of things worth checking again. Any of that person's normal PiStack agents can maintain it with `watch_list`, `watch_list_add`, `watch_list_update` and `watch_list_remove`. These tools accompany the asynchronous question tool in both Remote and Orchestrator sessions, and are also available to live dispatchers. Raw/sandbox sessions retain their declared restricted tools.

Each item contains `id`, `what`, `why`, optional `how`, optional `cadenceMs`, `nextDueAt`, `addedBy` (the adding thread ID), `createdAt`, `updatedAt`, and optional `lastThreadId`. Times are Unix epoch milliseconds. A new item defaults to due now; absent cadence uses the person's configured interval. Cadences must be at least one minute. An update preserves omitted fields; `how:null` and `cadenceMs:null` clear those options. Removal deletes the current item, not the checking threads' history.

```json
{
  "what": "Check whether the example service has recovered",
  "why": "Its status determines whether a follow-up is still needed",
  "how": "Read its status endpoint and the owning incident record",
  "cadenceMs": 3600000,
  "nextDueAt": 1790985600000
}
```

Do not seed personal checks into source or configuration. Agents add real items through the tools after release.

## Scheduler and decisions

The person's unlocked Remote supervisor owns the scheduler. It polls due times every 30 seconds without inference. The default repeat cadence and minimum spacing between automatic batches is 45 minutes. The person's configured interval is a floor: shorter item cadences cannot override it, and newly added or retimed items join the next eligible batch. Longer item cadences are preserved. The global next-wake time is durable across supervisor reloads. An empty list, a list with nothing due, or a disabled scheduler makes no model call. Locking the person's encrypted folder stops its supervisor and therefore stops its watch agent too.

A due batch creates a visible root **Watch list check** thread, pinned to `anthropic/claude-opus-5-5`, high thinking, standard speed. It uses ordinary persistent thread execution and its tools; it cannot spawn workers. At most one watch check runs at a time, including decision continuations. The scheduler advances selected items' next due time when it durably records the wake; the agent may change their timing, remove resolved items, or add follow-ups. The check prompt asks the agent to read the live list first, check current evidence, act on routine follow-ups, report unfinished checks plainly, and finish.

Spending money, commitments on the person's behalf, irreversible actions and other consequential decisions go through `request_user_input_async`, not autonomous approval. Its questions remain attached to the checking thread and answers resume that thread through normal human steer delivery. Items from a batch with pending questions do not create another check until those questions are answered; unrelated due items remain eligible. The question UI/notification contract is [asynchronous questions](../apps/remote/docs/questions.md).

The scheduler is not a separate agent runtime. Recovery reconnects through the normal thread service. A pending wake contains an immutable spawn request and stable identity; restart or a lost acknowledgement retries that same request instead of creating another check. Current watch items and mutation receipts are committed atomically. A stale check prompt confers no additional authority.

## Configuration and custody

The person registry's `environment` configures the supervisor:

- `PI_REMOTE_WATCH_ENABLED`: default enabled; set `0` to stop automatic checks while retaining tools and items. Reload the supervisor to apply changes. Disabling does not cancel an already-running check; stop its thread separately if needed.
- `PI_REMOTE_WATCH_INTERVAL_MS`: default `2700000`; an integer of at least `60000`. Sets the default item cadence and the minimum spacing between automatic check batches. Item cadences shorter than this interval are clamped when scheduling; adding or retiming an item cannot bypass the batch limit.
- `PI_REMOTE_WATCH_DESTINATION`: default `home`; an offered full-context destination whose existing workspace admission determines cwd. Raw/sandbox destinations are rejected. No personal context picker files are loaded automatically.

The existing supervisor `DATA/threads.sqlite3` owns `watch_item`, `watch_request`, `watch_wake` and `watch_schedule` inside the person's encrypted data. There is no host-global watch store, plaintext mirror, cron or separate systemd service. Native check transcripts stay alongside other person-owned threads. The main Orchestrator directory forwards watch operations to its authorized `person` owner; it never stores another copy in the fleet ledger. An unavailable or locked person owner is an explicit tool error, not a reason to store personal items elsewhere. Service shutdown stops the poller before detaching threads and closes the watch connection.

`POST /v1/threads/watch` (or the local `/v1/thread-owner/watch`) accepts `{threadId, action}`. Mutations also require `requestId`; add uses `item`, update uses `id` and `patch`, remove uses `id`. Add/update/remove retries return the original receipt, even after removal. The owner verifies thread provenance at the normal capability boundary. Fleet service forwarding keeps the calling thread ID. The response is a domain `Result` containing `{items}`, `{item}`, or `{removed:true,id}`. Tools derive request identity from their thread and native tool call ID.

Errors appear in Remote's existing operational error store under `watch-list` and in the supervisor journal. Missing model capacity is visible on the ordinary check thread; the scheduler never substitutes a different model.

Implementation: [`watch-list.ts`](../packages/orchestrator/src/threads/watch-list.ts), [`pi-tools.ts`](../packages/orchestrator/src/threads/pi-tools.ts), and the supervisor integration in [`server.ts`](../apps/remote/server/server.ts). Focused acceptance: `npm test --workspace=pi-orchestrator -- tests/watch-list.test.ts`.
