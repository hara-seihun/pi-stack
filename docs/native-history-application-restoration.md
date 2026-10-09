# Historical application admission restoration

Owner: `deploy/native-history-restore-applications.mjs`. This is restoration, not native migration, source activation or writer shutdown.

A fleet's main receipt does not describe every isolated application database. The owning ledger declares each application through a `thread-boundary:<24-hex>` key; the old daemon starts those services before its main service. A historical fence left in one application can therefore reject the next controller's startup while its HTTP health listener remains available.

## Authority and invocation

Run the exact committed helper in two stages. Administrator `--authorize JSON` reads the original root-owned publication journal, requires its acknowledged `restored` phase, and binds one declared fleet UID/unit/data directory/ledger. Supply actual `ownerPid`, explicit `healthPort` and trusted `publisherUid`. The immutable legacy package comes from that historical journal, not caller inference.

The resulting root-owned identity-only certificate is under `/run/pi-native-history-authorizations`. Run `--restore CERTIFICATE` as that exact user in its actual unit mount namespace. It verifies the live kernel PID/cgroup/namespace and immutable old-source health before locking any state; repeats kernel proof under the database locks; checks health again after unlocking. It neither requires nor claims an uninstrumented source entry because it does not change a decoder or runtime generation.

Only ledger-declared application databases beneath the exact own directory are admitted. Symlinks, another candidate/source identity, missing original acquisition, closure, native readiness/retirement, partial historical schema and other observation contracts are explicit errors. Every application is preflighted before effects. There is no recursive scan or foreign-fence deletion.

## Preservation

The old maintenance tables contain cohort thread IDs and question/thread ID pairs, not canonical conversation bodies. Before removing the exact historical maintenance triggers/tables, the helper saves their original rows and trigger definitions in that application's own `native-history-restoration-CANDIDATE.json` (0600). The acknowledged result remains there for idempotent recovery. Canonical thread, question, work, execution and provider records are untouched. No native RPC, process stop, provider abort, model call or intake closure occurs.

A multi-database I/O failure reports its exact already-committed application IDs; it does not manufacture global readiness. A preimage whose acknowledgment was interrupted remains an explicit recovery error rather than an invented completion.

After every historical application has positively acknowledged restoration, the currently owning publication may perform its genuine coordinated restoration. That operation belongs to the publication worker. Do not race it with another restorer. A future controller handoff still needs source-owned accepted-provider/producer custody; application-fence removal is not writer-absence proof.

Focused proof: `node --test scripts/native-history-restore-applications.test.mjs`.
