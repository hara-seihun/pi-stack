# Shared core native custody

`packages/orchestrator/src/core/custody.ts` supplies the runtime factory used by the single host core. It never constructs a ThreadService, initializes a database, copies a transcript, or runs a scheduler. The core service owns its existing storage partitions and serialized adoption receipts. `core/root.ts` embeds consultation admission, consent and chosen-reply outboxes into that same service.

## Registered resources

Each validated `CoreScope` declares its data directory, exact native socket directory, UID/GID, storage paths and additional file/directory resources. `custody.namespace` names the prepared data view; `custody.retainedRunnerNamespace` names the original accepted runner view. New runners use the data view. Recorded runners are located by positive status within these registered views, never by caller-selected paths.

Process descriptors pin PID birth ticks and mount-namespace inode. Durable pinned descriptors name root-protected nsfs bind handles under `/run/pi-stack/namespaces`. Readers resolve those handles through `/proc/1/root` because private namespaces need not see later host mounts. Host descriptors mean PID1's mount namespace.

The shared core must start in a prepared static mount view where every persisted logical database/history path resolves to the same device/inode as its registered **data** namespace. Missing, locked, replaced or inaccessible views return `unavailable`; there is no plaintext-underlay fallback. A new FUSE generation may differ from the original runner view only with the owning adoption barrier's trusted generation-transfer receipt binding namespace identities, registered cipher/mountpoint and exact detached database/WAL hashes. Content similarity alone is not a custody proof.

`runtime.path()` admits configured exact files and descendants of declared directories. New outputs compare the nearest existing ancestor with the registered data namespace. Directory symlinks cannot escape their registered root. Resource registration does not grant conversational permission: unified policy still controls use.

## Native execution

Recorded control/session references remain logical original paths. The fixed Python resource helper performs socket byte transport and native metadata operations in the registered namespace as its UID. The Node adapter owns the namespace fd and stream bridge, not the accepted execution. Detaching a bridge cannot kill a runner. Direct connections are used when namespace and UID already agree. Socket symlinks are refused; namespace identity is checked before use. Recovery inspects all configured views and requires one positive owner, or explicit native absence with flock fences.

New registered runners use systemd **scopes**, whose inline child retains namespace, cwd and environment; a manager-launched service would lose the encrypted view. Slice limits and native unit receipts remain resource ownership, not another controller. Existing accepted generations remain independent. Adapter detach ends observation and requests natural drain without replaying inputs.

Deployment must pin original namespaces before supervisors stop and preserve their actual FUSE daemons in resource-only custody until retained runners drain. A namespace bind handle alone does not preserve a daemon killed with its supervisor cgroup. Future Remote and combined custody mounts use `-sharedstorage`; the prepared new generation also uses explicitly granted cross-UID access. These source changes do not alter existing mounts.

## Private consultations

`createCoreCustodyFactory(consultationScopeIds)` selects in-process adapters for the designated new-request scope and explicitly mapped original Root session scopes. Each registers one admitted constructor, consumes it once, accepts one fresh text input batch, advertises `batch-operations-v1`, and drains accepted judgments before process exit. Interrupted constructors/turns are not replayable.

Root uses each request's exact adopted ThreadService, shared capacity and native session file. `consultationOwners` maps original root session IDs to original scope IDs; an existing request without its original owner returns unavailable, never a replacement session. Cached terminal chosen replies need no new native owner. Admission/reply records stay in their existing private directories. Authorized transcript reads consult the exact private owner without copying history.

Request/consent databases each require detached adoption receipts and exclusive ownership locks. The core reconciliation clock owns consent/request outboxes. Admin access requires unified principal/resource grants and the existing specialized capability. Only the chosen reply leaves the confidential session.

## Focused proof and deployment boundary

`tests/core-custody.test.ts` attaches synthetic old-generation sockets through a real process descriptor, checks unchanged store identity/bytes, rejects changed PID birth and unregistered paths, proves atomic private-batch rejection and accepted judgment drain, and transports a large frame through the fixed Python bridge. Root managed-session tests exercise the actual shared ThreadService/capacity, exact queued original request adoption, replay fencing, terminal reply reuse and missing-owner errors.

Deployment owns generation-transfer validation, namespace pins, FUSE resource custody and callback listeners. No live handoff, mounts, grants or service activation are part of these adapter changes.
