# External action tools

`pi-actions` runs the installed canonical-authority CLI with JSON stdin. It does not directly open another namespace's private database. Native `action_inspect`, `action_submit`, `action_reconcile` use the same authority. [Action contract](https://github.com/hara-seihun/pi-stack/blob/rewrite/core/docs/action-journal.md) owns intent identity, scope, states, evidence and exact bypass inventory.

```sh
pi-actions --help
printf '%s' '{"id":"ACTION_ID"}' | pi-actions inspect
```

## Shell-less manager purpose resolution

Kenaznia has `external_action_resolve_purpose({ id, expectedRevision, evidence })`. Use the exact inspected action ID/revision and supporting original receipt. It invokes only `reconcile` / `resolve-purpose` through the configured own loopback supervisor/router and authenticated `PI_THREAD_TOKEN`. The server derives managing authority from that capability; callers cannot supply an operation, decision, actor, owner or thread override. Missing token/endpoint refuses without operator fallback. Returned metadata is only action ID, revision, state and resolved status.

This resolves a confirmed settled purpose (`succeeded` or `failed-before-effect`); it sends/replays nothing, does not settle an active/uncertain effect, and does not lift recipient holds. An unavailable response remains unconfirmed: inspect/reconcile the original action rather than create a new purpose or invent a revision. A worker's existing authenticated own-succeeded-action route remains unchanged.

For a retained manager, use its original current `ExtensionAPI.registerTool` with the candidate tool definition built from that manager's original `PiSessionOptions`/environment references. The SDK refreshes that same session's registry and active tool list in place. Its existing `PiExecution.setToolAdmission` must additionally admit this one name while preserving the original admission predicate for every other name. Bind the API to the exact session's current extension runtime and the execution owner to its `boundSession`; missing/ambiguous bindings refuse adoption. Keep session, history, inputs, environment and token references unchanged; do not reload, replace the session or serialize credentials. Read back the registered definition, prior active names plus this tool, and admission metadata without invoking an action. The synthetic retained-SDK case below proves both required updates and continued refusal of shell tools.

`packages/orchestrator/tests/manager-purpose-tool.test.ts` proves the actual registered tool against a temporary synthetic owner and authenticated existing server route; it never queries a live authority. For sealed/installed acceptance bind all three exact immutable consumer roots explicitly:

```sh
PI_PURPOSE_PROBE_ORCHESTRATOR=/srv/pi/.pi-stack-releases/orchestrator/COMMIT/dist \
PI_PURPOSE_PROBE_REMOTE=/srv/pi/.pi-stack-releases/remote/COMMIT \
PI_PURPOSE_PROBE_SDK=/absolute/selected/node_modules/@earendil-works/pi-coding-agent \
bun test /absolute/retained-source/packages/orchestrator/tests/manager-purpose-tool.test.ts
```

The Remote path binds unchanged authorization source; the orchestrator path imports actual installed tool/caller modules; the SDK path binds retained dynamic registration to the selected dependency closure. The test injects only a synthetic transport and never changes installed files or native objects.

## Owning-operator reconciliation

Run `pi-actions` as the registered owning Unix account against its configured loopback router. For an explicitly authorized operator action, omit `PI_THREAD_TOKEN`: the router authenticates the process's owning UID. A supplied thread token selects thread authority instead; actor text does not grant operator or managing-thread authority.

Inspect first, then use that exact revision and the original provider receipt to resolve a confirmed delivered purpose:

```sh
printf '%s' '{"id":"ACTION_ID"}' | env -u PI_THREAD_TOKEN pi-actions inspect
printf '%s' '{"id":"ACTION_ID","expectedRevision":3,"decision":"resolve-purpose","evidence":{"kind":"provider-receipt","reference":"ORIGINAL_RECEIPT_REFERENCE","detail":"ORIGINAL_RECEIPT_DETAIL"},"actor":"authorized-owning-operator"}' | env -u PI_THREAD_TOKEN pi-actions reconcile
printf '%s' '{"id":"ACTION_ID"}' | env -u PI_THREAD_TOKEN pi-actions inspect
```

Replace the fixture identities, revision and evidence with the inspected record. Confirm `ok: true` and `resolved: true` in the readback. This resolves only the purpose: it neither resends the delivered request nor lifts recipient holds. Active or uncertain effects require their own provider-evidence reconciliation and cannot be resolved into a new contact.

### Reconcile decisions

Every reconciliation requires the exact inspected `expectedRevision`, an explicit `actor`, and evidence for the chosen decision. Actor text alone grants no authority. An `inflight` action cannot be reconciled.

| Decision | Required state/evidence | Result |
| --- | --- | --- |
| `effect-confirmed` | `uncertain` with `provider-receipt` evidence | `succeeded`; purpose remains unresolved |
| `no-effect-confirmed` | `uncertain`, `held`, `accepted`, or `failed-before-effect` with `provider-rejection` evidence | `failed-before-effect`; purpose resolved |
| `resolve-purpose` | `succeeded` or `failed-before-effect`, with supporting evidence | Purpose resolved; no effect replay |
| `hold` | Explicit recipient-hold evidence | Recipient hold retained; an `accepted` action becomes `held` |

Use the revision returned by `effect-confirmed` for any subsequent `resolve-purpose` request; the previous revision is stale. Neither purpose resolution nor effect reconciliation lifts recipient holds or sends the request again.

## Installed proof

`acceptance.ts` is safe installed behavior proof. It exercises installed core/HTTP/telephone modules using temporary synthetic owners, fake effects and twelve independent HTTP clients. It additionally makes one real canonical-owner **read-only** query for a fresh nonexistent synthetic ID, never submits a live action or contacts a recipient. Run as the registered owning Unix account; Remote and Runtime must have matching release markers.

```sh
bun /srv/pi/tools/external-actions/acceptance.ts --root /srv/pi --output /absolute/private/proof.json
# Installed code only, for hosts without a granted canonical-owner route:
bun /srv/pi/tools/external-actions/acceptance.ts --root /srv/pi --synthetic-only --output /absolute/private/installed-proof.json
# Source-only fixture, no live supervisor request:
bun tools/external-actions/acceptance.ts --source-root "$PWD" --output /absolute/private/source-proof.json
```

Proof scope is explicit: `--synthetic-only` reports `installed-synthetic`, not live route readiness; it never masks a failed route probe. The synthetic provider counter proves at-most-once dispatch, uncertainty fencing and authenticated worker purpose resolution, not external provider delivery. The real route query proves owner-bound serving without reading private action records. Publication's independent host proof owns release/Android/client readiness. No temporary fixture database is retained.
