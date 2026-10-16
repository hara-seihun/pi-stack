# Owned Signal effects

`MessagingService` owns the authenticated agent-only Signal send/reaction boundary. Its dispatch authority is `kenan-memory/actions`, injected in fixtures and opened by the trusted own-person supervisor at `<privateDir>/.kenan-actions` in production. This is the same owner-bound authority used by mail and telephone; the messaging database is a projection, not a second dispatch authority. Incoming request bodies cannot select an owner or change the action source.

Every effect reserves its canonical recipient and purpose, claims a generation, persists its action ID/ticket in `messaging_action_requests`, then enters the authority's one-shot dispatch immediately before invoking the provider. A new request UUID does not authorize another effect. Existing accepted actions without native projections can be claimed once; inflight, uncertain, held and settled actions never dispatch again. There is no lease timeout or automatic retry.

`intentKey` is an optional stable task identifier. Without one, the purpose is a digest of canonical recipient, message text, immutable attachment content hashes/metadata and quote target, or the reaction target/emoji/removal. Local conversation/upload/request UUIDs and local file paths are excluded. Signal aliases resolve to E164 `tel:` identity when a number is known, matching the telephone authority. All known aliases share the reservation, so learning a number later cannot free the previous Signal slot. Unknown aliases use their known Signal identity; no email/phone equivalence is guessed.

A different purpose or transport still encounters the recipient's unresolved contact slot and returns an `action_fenced` refusal, actionable resolution message and prior action, not acceptance of the new request. Same-intent changed payload returns `action_payload-conflict`. Exact retries alone reuse the existing receipt. Provider acceptance leaves that slot unresolved. An uncertain effect keeps it too. Native history and receipts remain readable without sending; lost message projections can be rebuilt from an already committed provider result. Receipt persistence failure leaves the action fenced and reports a no-resend warning.

Authorized new effects use explicit evidence, not another UUID. HTTP sends and reactions accept:

```json
{"followup":{"actionId":"prior-action-id","revision":3,"evidence":"Owner authorized this distinct followup after the original purpose completed"}}
```

The authority atomically resolves the settled prior purpose and reserves the next effect. It rejects uncertain/active prior effects, stale revisions and recipient holds. `pi-signal --intent-key PURPOSE` carries task identity; reconciliation and purpose resolution also remain available through the shared action tools. Claiming a followup is not evidence that a person granted it: agents must supply their actual authority and observation.

These routes are agent tools, not human chat input. No human-authored messaging route exists here. An incoming `source` override is rejected. A future human composition path must authenticate an explicit human action source and define its legitimate new-effect semantics at that boundary; it must not route ordinary user input through the autonomous-contact workflow or let agents forge that source.

Historical native send/reaction requests are adopted without provider invocation. Unknown requests take priority when acquiring recipient slots. Missing historical attachment bytes have an explicit unavailable-content payload. Fenced historical imports are recorded in `messaging_action_refusals`, never mapped to the unrelated blocking action's receipt. A rejected historical unknown request also places a recipient hold, preventing resolution of the other action from silently freeing the unknown contact. Native historical statuses remain intact; migration does not claim historical delivery beyond the native receipt's status.

## Coverage

Covered: owned `pi-signal` HTTP text/attachment sends, direct/group targets, quotes, reactions and removals, across own-person Signal profiles. Existing action journaling continues at the same boundary.

Not intercepted: raw `signal-cli`, browser/app sends outside this owner, shell scripts invoking Signal directly, or unrelated providers. Those bypasses are not made safe by a journal entry. Operators must use the owned boundary for enforced fencing.

Synthetic checks (no real account, provider or send):

```sh
bun test apps/remote/server/messaging/service.test.ts apps/remote/server/messaging/index.test.ts apps/remote/server/signal-cli.test.ts
```
