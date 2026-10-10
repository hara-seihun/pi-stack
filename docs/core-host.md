# Shared core host deployment

[Deployment](deployment.md) → host-owned configuration and [custody](core-custody.md).

One `pi-stack-core.service` owns all declared scope ThreadServices, provider broker, root consultation, memory and image custody. It runs Bun from `/srv/pi/pi-orchestrator/dist/core/main.js`. The historical artifact/import package name is retained; it is not a per-person daemon. Remote, rooms, router, Meet, Phone and shared OpenAI Voice remain transport owners.

## Configuration and source

`/etc/pi-stack/core.json` is protected root-owned configuration. The source parser in `packages/orchestrator/src/core/config.ts` owns its schema. Principals, credential digests, scope sets, permission policy, native callback transports, provider ledger mappings, manager origins and availability are explicit. A missing grant or adoption descriptor refuses startup. Inactive or locked scopes remain listed and unavailable; deployment never unlocks them.

```sh
bun /srv/pi/pi-orchestrator/dist/core/main.js --check-config /etc/pi-stack/core.json
bun /srv/pi/pi-orchestrator/host/core-host.mjs check /srv/pi/pi-orchestrator /etc/pi-stack/core.json
```

`deploy/orchestrator --install-core` installs the two core units and reloads systemd without starting them. It updates only configuration `releaseCommit` to the selected immutable source. `bind-person` consumes a protected `/etc/pi-stack/users/USER/core-binding.json` with `{version:1,user,scopeId,tokenFile}`. It verifies the existing service-purpose digest and exact owner scope before writing `core.env` and the Remote unit's binding. It does not create credentials or grants. Native callers use `PI_CORE_URL`, `PI_CORE_SCOPE_ID`, `PI_CORE_TOKEN_FILE`; broker calls use the same bearer at `/v1/model-broker`.

The three workspace packages compile together through `scripts/workspace-closure.mjs`. Source export mappings break the declaration cycle without changing shared dependency symlinks. Successful emission replaces generated dist directories, including their raw module resources. Deployed runtime dependencies contain the immutable private package closure. Remote retains root instructions, not a second root execution runtime.

## Resource preparation and conservation

`core-adopt pin PLAN` creates durable mount-namespace handles in PID1's namespace under protected `/run/pi-stack/namespaces`. A pin binds exact process birth and namespace inode. Pins are made **before** original supervisors detach. A namespace pin alone does not keep FUSE alive: `core-adopt retain-fuse PLAN` moves only a validated original gocryptfs PID/birth/registered cipher into the already-running resource-only `pi-stack-core-custody.service` cgroup. It confirms that ownership and writes a protected receipt. No native model/controller is moved or restarted.

The custody service reads `/etc/pi-stack/core-custody.json`:

- `version:1`, unique `namespaceId`, explicit `resources` and `generations` arrays;
- a borrowed resource has canonical `path`, `kind:'file'|'directory'`, and exact source `namespace`;
- a generation has `user`, `registryPath`, `cipherDir`, `mountpoint`, original pinned `sourceNamespace`, owner `uid/gid`, existing root-custodied `keyFile`, and `mountReceiptPath`.

Borrowed handles become exact bind views in one private common namespace. A generation is permitted only when the owning registry and a presently active original encrypted mount agree. It mounts the same encrypted backing as the original UID using `-sharedstorage -allow_other -acl`; keys pass through an already-open stdin descriptor. It never initializes a cipher, copies storage, creates an absent storage target or unlocks an inactive folder. Its target mount and common namespace receipts are explicit. Namespace handles are resolved through `/proc/1/root` so private mount propagation cannot hide the pin.

`core-adopt transfer PLAN` certifies a drained generation. The plan names `scopeId`, `user`, registry/cipher/mountpoint, original `databasePath` and `sessionsDir`, source and target `{uid,gid,namespace}`, and four protected paths: `detachmentReceiptPath`, `sourceMountReceiptPath`, `targetMountReceiptPath`, `adoptionReceiptPath`. The adoption receipt lives in root host custody outside the transferred encrypted mount.

The original controller must supply its own detachment receipt. PID disappearance, elapsed time and an empty service are not detachment evidence. Source and target namespaces must be pinned; both must expose the same registered ciphertext. Two metadata-only DB/WAL SHA snapshots must agree after detach. The resulting existing version-1 receipt binds target dev/ino and preserves the original owner identity/time; `generationTransfer` additionally binds registry hash, cipher/mountpoint, both namespace and DB/WAL identities, and the retained native runner namespace. Native runners continue in the original resource view; new sessions use target data custody.

```sh
/srv/pi/pi-orchestrator/host/core-runtime preflight /srv/pi/pi-orchestrator /etc/pi-stack/core.json
/srv/pi/pi-orchestrator/host/core-runtime proof /srv/pi/pi-orchestrator /etc/pi-stack/core.json
```

`preflight` checks the common logical view against registered storage/resources without creating stores. `proof` requires healthy matching core ownership, exact adopted DB identities and read-only scoped native reference census; it outputs counts and hashes, not histories. Existing unresolved native-history receipts remain owned. Core admission/SQLite ownership refuses absent stores or missing receipts.

## Coordinated activation

Prepare immutable artifacts while old owners serve. Prepare pins and resource custody, drain only old SQLite/execution controllers, record their exact receipts, certify target generations, reconcile configuration and bindings, then start core. Old callback ports and broker completion IDs remain until explicitly adopted same-process transports and retained credentials can serve their accepted generations. Core health precedes Remote/rooms rotation. Phone and shared Live transport rotate together only when telephone idle; active Meet runtime source remains until its ordinary idle rotation.

`deploy/host` selects prepared artifacts, installs source/bindings and starts one core before changed transport owners. It never starts per-person engines or separate root/memory/broker factories. Missing authority, common resource view, detachment receipt or native reference is an explicit unfinished cutover, not permission to reset storage. Host handbooks record actual installation and serving outcomes separately from this source contract.

## Account and unlock reload

After the owning host helper prepares an explicit account registration or unlocks an existing registered resource view, `SIGHUP` reloads only the protected canonical configuration. Existing scope IDs, databases, keys, managers and adopted generations cannot be replaced through reload. New scopes and unavailable-to-adopt transitions use their own legitimate custody receipts. Invalid configuration leaves the running owner untouched.

Reload serializes with shutdown. Accepted in-process root judgments drain while their callback and memory services remain available. The core then releases its controllers and transports and adopts the next configuration in the same process; independent native execution hosts continue. Clients reconnect to durable inboxes and projections. A startup failure remains explicit unavailable custody, not a reset or replay; the same corrected configuration can be signalled again. Publication owns changes to the immutable release or host listener identity. Provisioning is complete only after the new scope is actually serving, not when the signal is sent.

## Completed-integration dependencies

`deploy/integration-retain.py STATE --execute` is the publication lifecycle owner for completed integration `node_modules`. It requires all receipts for that exact integration to be published, the publication worker lock, ignored/untracked dependencies and two complete all-UID live-reference censuses. Referenced integrations and inaccessible censuses refuse deletion. Source, Git, build outputs, proofs, receipts, selected `/srv/pi` closures and Bun's download cache are untouched. Each removal is fsynced in `STATE/dependency-retention.jsonl`. The worker runs collection when draining an empty queue; failure creates a retention alert without reversing a completed release.
