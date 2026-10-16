# Account capacity reservations

A capacity reservation dedicates an account to completion requests whose durable input metadata contains an exact matching subset. It can exist before the account is imported, so an incoming account can admit its intended queue before ordinary backlog takes the capacity.

```sh
pi-orchestrator account reserve openai-codex-1 \
  --metadata '{"caller":"review-pipeline","purpose":"document-tagging"}' \
  --reason 'Document queue capacity'
pi-orchestrator account reservation openai-codex-1
pi-orchestrator account unreserve openai-codex-1
```

The metadata filter matches stored completion input, not request titles or prompt text. Extra request metadata is allowed. Every reserved key must have the matching value. For example, `{"caller":"review-pipeline","purpose":"document-tagging","document":"example"}` matches the reservation above. A different caller or purpose does not.

Matching queued completions receive the reserved capacity first. Other new admissions, including ordinary `force: true` work and interactive routing, cannot claim the account. Already admitted workers retain their leases and finish. A reservation does not increase quota, reset provider meters, clear cooldowns, change the request's force flag or interrupt a run. Exhausted accounts remain exhausted.

## HTTP contract

- `GET /v1/accounts/:id/reservation` reads the reservation.
- `PUT /v1/accounts/:id/reservation` writes `{ "metadata": { "caller": "review-pipeline", "purpose": "document-tagging" }, "reason": "Document queue capacity" }`.
- `DELETE /v1/accounts/:id/reservation` releases it.

Account aliases need not already exist for these operations. This is separate from `account use ID voice`, which reserves an account for a different consumer class rather than matching completion metadata.

## Incoming account transfer

Create and read back the reservation on the destination before starting an [exclusive account transfer](account-transfer.md). Transfer imports the account's quota and attribution facts without replacing destination reservations. The source account's admission settings do not override the destination's capacity reservation.

When priority ordering is an explicit operator requirement, the transfer owner stops before sending the account to the destination until the scheduler owner confirms that ordering. No new completion or probe is needed: the existing queued request retains its idempotency identity and force flag and becomes eligible when capacity arrives.
