# Native future factory

The shared native runner owns physical storage and residents. A Core cutover can change the creator used by future opens without replacing that runner, releasing its kernel lease, or closing accepted residents. `native-future-factory-v1` is a separate capability from the session's `batch-operations-v1` input protocol.

## Upgrade

Runner `status` reports `nativeOwner`, `factoryProtocol`, `futureFactory`, and `residentFactories`. Each factory identity contains the canonical `pi-session.js` entry, its SHA256, the exact SDK package directory and the source commit. Upgrades require a commit-addressed release with `.pi-stack-commit` and a read-only SDK directory; selector paths are refused. Native Node uses `findPackageJSON` with the candidate URL to identify its ESM SDK package; Bun uses its candidate-scoped import resolver. Import-only SDK exports do not authorize a CommonJS require lookup or selection of the controller's SDK. Loading still verifies the candidate's exported SDK directory and execution contract.

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

`installRunnerFactoryBootstrap` in `runner-factory-bootstrap.ts` supports that finite first install. The owner supplies the actual original control Server and serial queue, base NativeRunnerOwner, original bridge/holder/birth `assertLease`, bridge evidence, an already validated sealed initial binding, original environment scope, exact resident provenance and canonical `loadRunnerFactory`. `bindFutureOpen(bootstrap)` synchronously binds the source-extracted sealed `runner-host.open` into the original module and returns a rollback; failure must leave the predecessor restored. The installer rechecks the lease before adding capability and rolls back the binding if installation fails. Call it on the original serial queue so preceding control operations settle before binding.

The returned support exports `futureFactory`, `initialEnvironmentScope`, `assertLease`, `bindRunnerEnvironments` and `status()`. It does not mutate the old resident SDK facade. New opens snapshot the broker and capture their module, identity and scopes. Old residents retain their original command/close closures; provenance is either exact adapter function-location evidence or explicitly unresolved, never guessed from the current creator.

An additive connection hook handles only future control sockets. It intercepts complete `upgrade_factory` lines before the original readline parser, preserving fragmented UTF-8 and coalesced frames, and augments the original synchronous status reply. Other frames go to the unchanged original listener. Existing connections, server, listeners, paths, residents and accepted channel commands remain intact. CAS, identity loading and lease decisions stay in `RunnerFutureFactory`; the bootstrap has no second implementation. A duplicate bootstrap or different process/control is refused.

## Focused proofs

`runner-factory-bootstrap.test.ts` covers real Unix-socket fragmentation/coalescing, unchanged original listeners and preexisting connections, old resident/facade preservation, duplicate installs, invalid requests and binding rollback after lease loss. `runner-factory*.test.ts` cover creator preservation, dual environment binding, lease-loss/CAS errors, exact loading and retained-owner protocol classification. `pi-orphan-projection.test.ts` uses the actual cached SDK runtime and repeated `newSession` replacements. `packages/runtime/orphan-tool-results.test.mjs` exercises all three common provider-transform copies and unchanged native evidence.
