# Missing capability key epoch

Owner: `deploy/core-capability-epoch.py`, consumed by `deploy/core-adopt initialize-capability`.

A missing historical key is not proof that no issuer existed. This operation creates an explicitly new epoch only after the original owners have positively detached and their native capabilities have been released. It never adopts, overwrites or reconstructs an old key.

## Preparation

The root-owned plan has `version:1`, `priorCapability:"absent-after-drain"`, exact `uid`, `gid`, `keyPath`, `proofPath`, `nativeCloseSource:{path,sha256}`, and every original owner in `owners`:

- `scopeId`, `databasePath`, registered original `namespace`, registered `socketDir`;
- `detachmentReceiptPath` from `core-drain`.

Run `python3 core-capability-epoch.py ABSOLUTE_ROOT_PLAN` only after original ingress/controller drain. The producer reads technical execution metadata, never histories or messages. Every execution must have a terminal receipt. A live native control must report zero active sessions; only that original host's positively idle sessions may close. Its installed close implementation is hash-bound and must reject active/background work. Close acknowledgements must retain the exact PID, followed by a positive zero-session status. Recorded absent generations require possession of their existing kernel owner lock, not absence of a PID. Unrecognized or uncertain resources return `capability-epoch-unconfirmed`; no prompt, replay or resume is sent.

The resulting root-owned `pi-core-capability-epoch-drained-v1` proof binds original DB identities, execution IDs, native references and controller receipts. Currently accepted inputs/tools are never cancelled by this preparation. A last-session close whose host disappears before zero-session acknowledgement remains unconfirmed; reconcile its kernel lease on the next inspection rather than replaying accepted model work.

## Initialize

The existing initialization plan uses `priorCapability:"absent-after-drain"`, `sourceProof:{kind:"detached-capability-epoch",path,sha256}`, complete `ownerScopeIds`, registered `keyBasePath`, and its exact `scopeId`, `uid`, `gid`, `namespace`, `keyPath`, `databasePath`, `receiptPath`.

The initializer revalidates the original owner cohort and native quiescence before creating the key. A declared ordinary owner base may receive new UID-owned mode0700 subdirectories; the key is created mode0600 with exclusive creation. Existing files are never replaced. The initialization receipt is reserved before the effect. A crash leaving `state:"preparing"` returns an explicit uncertain-effect error; inspect and reconcile that exact receipt instead of creating another key or rephrasing the purpose. `state:"initialized"` permits inspection of the already-created exact key identity without repeating the effect.

Existing UID-owned intermediate directories may be0755 when protected against group/other writes; the final key directory remains0700. `core-adopt reconcile-capability ROOT_PLAN` handles only the exact preparing reservation rejected by the earlier private-ancestor check before key open. It revalidates the sealed original cohort and affirmatively observes that same owner ancestor's failing mode, exact device/inode and absent key. The receipt becomes `failed-before-effect`, retaining its original reservation and rejection evidence; initialization resumes that same plan once and preserves reconciliation in the initialized receipt. Other uncertain failures are not admitted by this operation.

The separate `priorCapability:"none"` / `owner-source-no-capability` variant remains available for an original encrypted owner that demonstrably had no issuer. Historical absence must not be relabelled as that variant.
