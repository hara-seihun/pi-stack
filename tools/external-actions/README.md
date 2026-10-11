# External action tools

`pi-actions` runs the installed canonical-authority CLI with JSON stdin. It does not directly open another namespace's private database. Native `action_inspect`, `action_submit`, `action_reconcile` use the same authority. [Action contract](https://github.com/hara-seihun/pi-stack/blob/rewrite/core/docs/action-journal.md) owns intent identity, scope, states, evidence and exact bypass inventory.

```sh
pi-actions --help
printf '%s' '{"id":"ACTION_ID"}' | pi-actions inspect
```

## Owning-operator reconciliation

Run `pi-actions` as the registered owning Unix account against its configured loopback router. For an explicitly authorized operator action, omit `PI_THREAD_TOKEN`: the router authenticates the process's owning UID. A supplied thread token selects thread authority instead; actor text does not grant operator or managing-thread authority.

Inspect first, then use that exact revision and the original provider receipt to resolve a confirmed delivered purpose:

```sh
printf '%s' '{"id":"ACTION_ID"}' | env -u PI_THREAD_TOKEN pi-actions inspect
printf '%s' '{"id":"ACTION_ID","expectedRevision":3,"decision":"resolve-purpose","evidence":{"kind":"provider-receipt","reference":"ORIGINAL_RECEIPT_REFERENCE","detail":"ORIGINAL_RECEIPT_DETAIL"},"actor":"authorized-owning-operator"}' | env -u PI_THREAD_TOKEN pi-actions reconcile
printf '%s' '{"id":"ACTION_ID"}' | env -u PI_THREAD_TOKEN pi-actions inspect
```

Replace the fixture identities, revision and evidence with the inspected record. Confirm `ok: true` and `resolved: true` in the readback. This resolves only the purpose: it neither resends the delivered request nor lifts recipient holds. Active or uncertain effects require their own provider-evidence reconciliation and cannot be resolved into a new contact.

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
