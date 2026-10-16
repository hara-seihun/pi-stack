# External action tools

`pi-actions` runs the installed canonical-authority CLI with JSON stdin. It does not directly open another namespace's private database. Native `action_inspect`, `action_submit`, `action_reconcile` use the same authority. [Action contract](../../docs/action-journal.md) owns intent identity, scope, states, evidence and exact bypass inventory.

```sh
pi-actions --help
printf '%s' '{"id":"ACTION_ID"}' | pi-actions inspect
```

`acceptance.ts` is safe installed behavior proof. It exercises installed core/HTTP/telephone modules using temporary synthetic owners, fake effects and twelve independent HTTP clients. It additionally makes one real canonical-owner **read-only** query for a fresh nonexistent synthetic ID, never submits a live action or contacts a recipient. Run as the registered owning Unix account; Remote and Runtime must have matching release markers.

```sh
bun /srv/pi/tools/external-actions/acceptance.ts --root /srv/pi --output /absolute/private/proof.json
# Installed code only, for hosts without a granted canonical-owner route:
bun /srv/pi/tools/external-actions/acceptance.ts --root /srv/pi --synthetic-only --output /absolute/private/installed-proof.json
# Source-only fixture, no live supervisor request:
bun tools/external-actions/acceptance.ts --source-root "$PWD" --output /absolute/private/source-proof.json
```

Proof scope is explicit: `--synthetic-only` reports `installed-synthetic`, not live route readiness; it never masks a failed route probe. The synthetic provider counter proves at-most-once dispatch, uncertainty fencing and authenticated worker purpose resolution, not external provider delivery. The real route query proves owner-bound serving without reading private action records. Publication's independent host proof owns release/Android/client readiness. No temporary fixture database is retained.
