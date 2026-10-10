# Auxiliary custody capture

[Core host](core-host.md) owns activation. `deploy/core-auxiliary.ts` captures manager identity, notification cursors and origins, held/archive flags, accepted watch/wake row identities and native image source watermarks. It opens existing SQLite stores read-only and publishes metadata only into protected root custody. It does not adopt stores, stop controllers, authorize resources or export transcript/watch bodies.

Run in the declared source/common resource namespace:

```sh
sudo bun deploy/core-auxiliary.ts /absolute/root-owned/plan.json
```

The plan and output parent are protected root-owned paths. The command prints only a typed result containing output path, SHA-256, scope count and phase. On failure it exits75 with `auxiliary-capture-unavailable`; there is no partial successful output.

## Explicit plan

The exported `AuxiliaryPlan` type owns the exact schema. Required top-level fields are `version:1`, `phase:'baseline'|'detached'`, `outputPath`, `baselinePath:string|null`, `baselineSha256:string|null`, and `scopes`.

Each scope declares:

- `id`, `availability:'available'|'unavailable'`, exact `threads` and optional `supervisor` identities `{path,dev,ino}` (decimal strings), plus registered `sessionRoots`;
- `manager:{kind:'supervisor'}` to read original `manager_view`, or an explicitly evidenced `none`/`existing` declaration;
- exact canonical `managerRouting`, `images` registry specification or null, and `duties` entry or null. These are existing authority projections, not values inferred by this collector;
- `missingCursor:{kind:'reject'}` or `original-zero` with the exact original notification source path/SHA proving its absent-cursor behavior;
- `detachedReceiptPath:string|null` and `liveOwner:{pid,startTicks}|null`.

Unavailable scopes require explicit retained manager declarations and are untouched. An existing image/watch registry cannot be silently disabled. An existing manager cannot be silently replaced by none. Missing cursors are not assumed zero. The assembler validates complete canonical configurations with the core parser.

## Two-phase ordering

1. Capture **baseline while original Remote image ingress is alive**, before detaching it. PID and birth are checked before and after bounded native source indexing. Protect the resulting output and its SHA. Missing, not-yet-created native files receive an explicit unstarted watermark; no historical definition is guessed.
2. Drain the original owner using its owning handoff. Its protected detachment receipt binds scope, database path/dev/ino and previous owner identity/time.
3. Capture **detached** using that receipt and the exact baseline path/SHA. Final cursors, origins and retained metadata come from the drained stores. Native image watermarks remain the earlier live-ingress offsets: advancing them to the final transcript head would lose messages completed while Remote was absent. Threads created after baseline receive a beginning watermark only when their stored creation time proves that relationship.
4. The adoption receipt writer binds `evidence[].nativeImageSources` and `imageTableNames` to each exact image table-owner receipt. The assembler consumes `scopes`, `images`, and `duties`. Keep baseline/final output hashes with the transfer evidence.

A live-owner baseline establishes the old/new source boundary, not proof that every historical tag was accepted. Core checks pre-baseline tags against retained message receipts too; a missing acknowledgement is an explicit historical uncertainty, never silently skipped as completed or replayed. This also covers a native message finalized just before capture whose Remote event had not yet been admitted. Image ingress deduplicates overlap using its retained message/definition receipts. Watch custody may reside in the thread database or supervisor database; the declared duty database must match the actual table owner exactly. Watch spool payloads remain in the original database; exported row IDs/hashes prove conservation without copying their bodies. The capture receipt itself is never a detachment or activation receipt.

Seven disposable tests cover metadata-only capture, missing-value rejection, inactive custody, bounded watermarks, retained watch identities and the baseline-to-detached gap. Run the root-only receipt test against disposable temporary fixtures with `sudo bun test deploy/core-auxiliary.test.ts`.
