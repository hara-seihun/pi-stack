# Auxiliary custody capture

[Core host](core-host.md) owns activation. `deploy/core-auxiliary.ts` captures manager identity, notification cursors and origins, held/archive flags, accepted watch/wake row identities and native image source watermarks. It opens existing SQLite stores read-only and publishes metadata only into protected root custody. It does not adopt stores, stop controllers, authorize resources or export transcript/watch bodies.

Run in the declared source/common resource namespace:

```sh
sudo bun deploy/core-auxiliary.ts /absolute/root-owned/plan.json
```

The plan and output parent are protected root-owned paths. The command prints only a typed result containing output path, SHA-256, scope count and phase. On failure it exits75 with `auxiliary-capture-unavailable`; there is no partial successful output. The CLI atomically persists `outputPath.run.json` (root0600) with its run/PID/plan hash, current scope/source identity, and running/failed/complete result. Progress is refreshed at scope transitions and at most once per second during native hashing; it is observation, not a reusable adoption checkpoint. Failure preserves an existing successful output. Inspect the same run after a transport timeout before starting another scan.

## Explicit plan

The exported `AuxiliaryPlan` type owns the exact schema. Required top-level fields are `version:1`, `phase:'baseline'|'detached'`, `outputPath`, `baselinePath:string|null`, `baselineSha256:string|null`, and `scopes`.

Each scope declares:

- `id`, `availability:'available'|'unavailable'`, exact `threads` and optional `supervisor` identities `{path,dev,ino}` (decimal strings), plus registered `sessionRoots`;
- `manager:{kind:'supervisor'}` to read original `manager_view`, or an explicitly evidenced `none`/`existing` declaration;
- exact canonical `managerRouting`, `images` registry specification with explicit `relatedThreadScopeIds` or null, and `duties` entry or null. These are existing authority projections, not values inferred by this collector;
- `missingCursor:{kind:'reject'}` or `original-zero` with the exact original notification source path/SHA proving its absent-cursor behavior;
- `detachedReceiptPath:string|null` and `liveOwner:{pid,startTicks}|null`.

Unavailable scopes require explicit retained manager declarations and are untouched. A registry's explicitly related thread scopes contribute their registered native sources to the same baseline. A fleet scope may borrow Remote supervisor metadata without declaring another image registry when that exact database already has a declared registry owner in the plan. An existing image/watch registry cannot be silently disabled. An existing manager cannot be silently replaced by none. Missing cursors are not assumed zero. The assembler validates complete canonical configurations with the core parser.

## Two-phase ordering

1. Capture **baseline while original Remote image ingress is alive**, before detaching it. PID and birth are checked before and after canonical fixed-prefix streaming watermark capture. The scanner hashes raw complete records in64KiB chunks without parsing historical bodies, so valid historical tool outputs larger than the UI record limit remain capturable. Protect the resulting output and its SHA. Missing, not-yet-created native files receive `priorSource:{kind:'absent',observedAt}` bound to the exact thread/path. Newly registered post-baseline threads receive `priorSource:{kind:'created-after-baseline',createdAt,baselineStartedAt}` with ISO dates and stored creation evidence. These explicit declarations allow their first new file to start from an empty prefix. Five cursor fields or a revision label alone never authorize historical replay.
2. Drain the original owner using its owning handoff. Its protected detachment receipt binds scope, database path/dev/ino and previous owner identity/time.
3. Capture **detached** using that receipt and the exact baseline path/SHA. Final cursors, origins and retained metadata come from the drained stores. Native image watermarks remain the earlier live-ingress offsets: advancing them to the final transcript head would lose messages completed while Remote was absent. Threads created after baseline receive a beginning watermark only when their stored creation time proves that relationship.
4. The adoption receipt writer binds every field of `evidence[].nativeImageSources` (including full byte-prefix/inode/digest proof, not just the five original cursor fields) and `imageTableNames` to each exact image table-owner receipt. The assembler consumes `scopes`, `images`, and `duties`. Keep baseline/final output hashes with the transfer evidence.

A live-owner baseline establishes the old/new source boundary, not proof that every historical tag was accepted. Historical record bodies remain unexamined; their actual accepted work stays in the existing registry. No historical completion or acknowledgement coverage is inferred from a source watermark. Core verifies the full prefix proof before processing the new bounded suffix; unknown old cursor formats and unreadable new records remain explicit uncertainty, never permission to replay historical generation. Image ingress deduplicates overlap using its retained message/definition receipts. Watch custody may reside in the thread database or supervisor database; the declared duty database must match the actual table owner exactly. Watch spool payloads remain in the original database; exported row IDs/hashes prove conservation without copying their bodies. The capture receipt itself is never a detachment or activation receipt.

Disposable tests cover metadata-only capture, missing-value rejection, inactive custody, bounded watermarks, retained watch identities and the baseline-to-detached gap. Run the root-only receipt test against disposable temporary fixtures with `sudo bun test deploy/core-auxiliary.test.ts`.
