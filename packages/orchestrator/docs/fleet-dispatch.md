# Fleet children and coordinator return

A normal fleet run assigned Astra or Sol receives `fleet_dispatch`. The tool accepts `task`, an exact `model` from Astra/Sol/Terra/Luna, an optional `requestId`, and an optional `escalatesRunId`. Model descriptions come from Hara's verbatim text in the shared catalog. The worker adds no delegation policy or system prompt.

The child receives the supplied task, the parent's cwd and budget, and the normal fleet environment. It starts its own transcript. It does not copy the coordinator's transcript. Astra and Sol children can dispatch their own children. Terra and Luna children cannot dispatch. Isolated application runs receive no fleet tools, cannot use the dispatch endpoint, and keep their existing context and single-turn completion contract.

## Dispatch contract

`POST /internal/runs/:parentRunId/dispatch` accepts:

```json
{
  "requestId": "unique-within-parent",
  "task": "One-off task text",
  "model": "terra"
}
```

The response is `201 { run: Run }`, including `parentRunId`, `rootRunId`, `requestedModel`, and `deliveryState`. The tool defaults `requestId` to its Pi tool-call ID. Repeating a request ID with the same input returns the same child; changing its input returns `request-conflict`. Dispatch requires a running, non-isolated Astra or Sol parent. Validation errors return HTTP 400 with an error code. If the daemon accepts a dispatch but its response is lost, worker recovery completes the outstanding `fleet_dispatch` tool call using the original call ID before prompting the model again.

A child records its provider, model and thinking level at dispatch, before quota admission. Admission uses that recorded candidate rather than resolving the current profile again. Worker recovery retains its release and transcript. The routing extension enforces the model pin before its assigned-worker branch, during session restoration and model selection, and at provider-request time. Remote uses the same guard through `PI_SUBAGENT_MODEL`, accepting an exact physical model ID such as `gpt-5.6-luna` or its catalog ID `luna`; fleet pins come from the assigned run row. The pin fixes the provider family and model, not the pooled account alias. Same-model account changes remain allowed. Unknown non-empty pins abort provider requests rather than disabling the guard. No endpoint changes the child's model. Escalation supplies a different model and the ID of an existing child of the same parent. It creates another child and leaves the first child unchanged.

Children enter the ordinary admission queue. They inherit background or forced admission from their parent; dispatch does not bypass account or machine capacity and does not bank admissions or reset meter history.

## Settlement and recovery

While a coordinator is working, its two-second worker control exchange picks up pending child results. `FleetResultDelivery` submits each result with `deliverAs: "steer"`, so Pi can consume it after the current tool calls without waiting for the coordinator's whole turn to end. These automatic results never use the follow-up queue. Existing pending ledger results use this same path.

When a fleet worker completes a turn, the daemon commits one of two outcomes:

- `done` when no child or undelivered result remains.
- `waiting` when a child is unfinished or a terminal child result has not reached the coordinator transcript.

A waiting coordinator releases its account lease and exits. The daemon excludes it from progress/stall checks. Once a child has a terminal result, the daemon resumes the coordinator from its recorded release and Pi session file. It waits for the previous unit to become inactive before restarting it. Resume respects pause, account availability and concurrency ceilings, but does not spend another meter admission for the already-admitted run. It prefers the original account; if that account is unavailable or full, it can select another account for the exact same provider/model/thinking combination. The waiting interval does not count as a worker stall. Waiting coordinators still count as assigned lane work, so a lane does not gain scheduling priority merely by delegating.

The terminal child run row is the durable result outbox. A failed or aborted child returns its state, failure kind and result just like a successful child. `GET /internal/runs/:id` includes pending `results` alongside the run. Each result has the stable delivery ID `fleet-result:<childRunId>`.

The receiving worker submits a `fleet-result` custom message containing the result and delivery ID. Enqueuing a steer is not a receipt. The worker waits until Pi actually appends the message to the active transcript branch, then fsyncs that transcript before `POST /internal/runs/:id/acknowledge` with `{ deliveryIds: [...] }`. When reopening an idle coordinator, it writes the same result receipt before starting the continuation. Delivered means the result is in the durable transcript, not that the coordinator has answered it yet. The coordinator remains an active recoverable run until it settles its next turn.

If the process stops while a steer is still only in memory, its outbox row remains pending and recovery resubmits it. If it stops after transcript insertion but before acknowledgement, recovery finds the receipt on the active transcript branch and acknowledges it without inserting the result again. If the process stops after acknowledgement but before finishing its response, ordinary worker recovery continues the same transcript. A final assistant response already in the transcript is settled without asking the model to repeat it. Terminal child rows cannot be reopened or overwritten by delayed worker updates.

Stopping or failing a coordinator prevents automatic wakeup. Its children's records and pending results remain observable. Operators can stop those children separately.

## Storage and observation

This feature uses the existing schema and the daemon's transaction owner:

- `run` owns task text, assignment, lifecycle, result and transcript location.
- `fleet-child:<runId>` in `control` owns the dispatch request, parent/root IDs, escalation link and fixed model candidate. It commits in the transaction that creates the child.
- `fleet-waiting:<runId>` projects a stored running row as `waiting`. Settlement writes it and releases the lease in one transaction. Resuming removes it while renewing the lease.
- `fleet-delivered:<childRunId>` records receipt acknowledgement. An unacknowledged terminal child remains pending across daemon restarts.

The SQLite owner uses full synchronous WAL commits. There is no schema transition or separate result worker to deploy.

`OrchestratorClient.listRuns()` includes waiting coordinators and queued/terminal children, with completed parents retained for discovery. The store applies the page limit in SQL and loads relationships in bulk rather than scanning child metadata for each historical run. Its `running` total and model counts include only starting/running workers. `ObservedRun` adds `parentRunId`, `rootRunId`, `childRunIds`, `requestedModel`, `escalatesRunId` and `deliveryState`. IDs are raw fleet IDs; Remote applies host qualification. `tailRun()` works after completion and includes received fleet result messages.

The caller's listing limit still applies. A missing parent row can be fetched directly through `tailRun(parentRunId, ...)`.

## Local proof

Run `npm test -w pi-orchestrator` and `npm run typecheck -w pi-orchestrator` from the repository root. Fleet tests cover all model choices, escalation and replay, isolated-run rejection, completion/settlement races, ledger reopening, a busy parent's steering receipt before its final response, transcript receipt deduplication after interrupted acknowledgement, recovery of an accepted dispatch with a lost response, and coordinator wakeup from the recorded release with one machine slot. Existing isolated-context and worker tests run in the same suite.
