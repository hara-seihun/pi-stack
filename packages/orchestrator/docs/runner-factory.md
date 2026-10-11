# Native future factory

The shared native runner owns physical storage and residents. A Core cutover can change the creator used by future opens without replacing that runner, releasing its kernel lease, or closing accepted residents. `native-future-factory-v1` is a separate capability from the session's `batch-operations-v1` input protocol.

## Upgrade

Runner `status` reports `nativeOwner`, `factoryProtocol`, `futureFactory`, and `residentFactories`. Each factory identity contains the canonical `pi-session.js` entry, its SHA256, the exact SDK package directory and the source commit. Upgrades require a commit-addressed release with `.pi-stack-commit` and a read-only SDK directory; selector paths are refused.

`upgrade_factory` carries the literal protocol, exact process/storage owner, expected predecessor identity and candidate identity. The native serial queue validates physical ownership before loading and before committing. Loading verifies the file identity, exported SDK/environment/factory contract, and shared provider projection files. A stale predecessor, changed source, unavailable module, invalid contract or lost lease returns a specific `errorCode`; no alternate creator is selected. The acknowledgement includes old/new identities and the unchanged resident factory census.

The normal transport performs this compare-and-swap before future `open` requests to a positively discovered retained owner. Namespace routing, physical-owner PID/birth, storage UID and control checks remain authoritative. An attached session's `nativeOwnership` distinguishes a positively discovered predecessor from a fresh launch. This classification permits only exact old-protocol drain observation, never invented batch capability or input replay.

## Residents and environment

A resident captures its creator and environment bindings once. Subsequent commands, close and in-runtime replacements keep that binding even after a future-factory upgrade. Old host and selected adapter AsyncLocalStorage scopes are nested with the same environment object; `process.env` is not changed. Explicit `PI_SESSION_WRITER_DIRECTORY` and `PI_SESSION_WRITER_SCOPE` remain mandatory. The physical owner lease and separate native-thread writer lease are not replaced by an upgrade.

Resident factory identities remain visible after upgrade. A predecessor resident is not silently relabelled as current. Upgrading the future creator does not change its existing SDK closures; an older runtime needs its independently proven projection hook or an ordinary positively idle reopen.

## Historical receipts

Every new Agent created by the Pi runtime factory receives `installOrphanReceiptProjection`, including `/new`, resume, fork and import replacements. It preserves the existing transform and projects unmatched tool results to labelled historical user evidence. It changes neither JSONL nor native messages, invents no tool calls, and replays no effects. The canonical algorithm lives in `src/threads/orphan-tool-results.mjs`; the runtime provider patch and tests consume that same file. Workspace closure copies it and its declaration into the deployed orchestrator, and SDK source/cache identities include both.

The per-Agent hook covers cached SDK ordinary requests. The common provider patch covers independent compaction/direct-provider paths in a newly loaded immutable SDK graph. On-disk markers do not prove that an older already-cached provider module changed. Factory selection does not claim to retrofit those old modules or warmers.

## Pre-capability hosts

A predecessor without a factory protocol can still be attached through its exact existing socket and drained under its positively established ownership. A future socket cannot be opened there: transport returns `finite-bootstrap-required` and preserves the exact runner reference. An unknown advertised factory protocol is `factory-contract-invalid`, not an absent capability.

Original hosts without this API cannot acquire it by selecting new Core source. Their first installation requires a separately owned finite bootstrap or a lawful empty-host transition. The bootstrap is not an ordinary future upgrade.

## Focused proofs

`runner-factory*.test.ts` cover creator preservation, dual environment binding, lease-loss/CAS errors, exact loading and retained-owner protocol classification. `pi-orphan-projection.test.ts` uses the actual cached SDK runtime and repeated `newSession` replacements. `packages/runtime/orphan-tool-results.test.mjs` exercises all three common provider-transform copies and unchanged native evidence.
