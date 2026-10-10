# Shared core native custody

`packages/orchestrator/src/core/custody.ts` supplies the runtime factory used by the single host core. It never constructs a ThreadService, initializes a database, copies a transcript, or runs a scheduler. The core service owns its existing storage partitions and serialized adoption receipts. `core/root.ts` embeds consultation admission, consent and chosen-reply outboxes into that same service.

## Registered resources

Each validated `CoreScope` declares its data directory, exact native socket directory, UID/GID, storage paths and additional file/directory resources. `custody.namespace` names the prepared data view; `custody.retainedRunnerNamespace` names the original accepted runner view. New runners use the data view. Recorded runners are located by positive status within these registered views, never by caller-selected paths.

Process descriptors pin PID birth ticks and mount-namespace inode. Durable pinned descriptors name root-protected nsfs bind handles under `/run/pi-stack/namespaces`. Readers resolve those handles through `/proc/1/root` because private namespaces need not see later host mounts. Host descriptors mean PID1's mount namespace.

The shared core must start in a prepared static mount view where every persisted logical database/history path resolves to the same device/inode as its registered **data** namespace. Missing, locked, replaced or inaccessible views return `unavailable`; there is no plaintext-underlay fallback. A namespace change preserving the same physical database uses a root-owned detached receipt with `namespaceRebinding:{version:1,kind:"same-physical-object",source,target,retainedRunnerNamespace}`. Each source/target is exactly `{namespace,databaseIdentity:{dev,ino},files:{database:{sha256,size},wal}}`; WAL is `{kind:"absent"}` or `{kind:"present",sha256,size,identity:{dev,ino}}`. Both views must bind the same DB/WAL identities and bytes, and the exact configured retained/data namespaces. Runtime compares the current DB/WAL identities and hashes before acquisition. The owning adoption barrier observes both detached views; runtime never invents a receipt from matching paths or contents.

A new FUSE generation with a different physical database still requires the owning adoption barrier's trusted `generationTransfer` binding namespace identities, registered cipher/mountpoint and exact detached database/WAL hashes. Physical rebinding does not authorize cross-inode transfer, and the two variants cannot be combined. Content similarity alone is not a custody proof.

`runtime.path()` admits configured exact files and descendants of declared directories. New outputs compare the nearest existing ancestor with the registered data namespace. Directory symlinks cannot escape their registered root. Resource registration does not grant conversational permission: unified policy still controls use.

## Native execution

Recorded control/session references remain logical original paths. The fixed Python resource helper performs socket byte transport and native metadata operations in the registered namespace as its UID. The Node adapter owns the namespace fd and stream bridge, not the accepted execution. Detaching a bridge cannot kill a runner. Direct connections are used when namespace and UID already agree. Socket symlinks are refused; namespace identity is checked before use. Recovery inspects all configured views and requires one positive owner, or explicit native absence with flock fences.

New registered runners use systemd **scopes**, whose inline child retains namespace, cwd and environment; a manager-launched service would lose the encrypted view. Slice limits and native unit receipts remain resource ownership, not another controller. Existing accepted generations remain independent. Adapter detach ends observation and requests natural drain without replaying inputs.

Deployment must pin original namespaces before supervisors stop and preserve their actual FUSE daemons in resource-only custody until retained runners drain. A namespace bind handle alone does not preserve a daemon killed with its supervisor cgroup. Future Remote and combined custody mounts use `-sharedstorage`; the prepared new generation also uses explicitly granted cross-UID access. These source changes do not alter existing mounts.

## Private consultations

`createCoreCustodyFactory(consultationScopeIds)` selects in-process adapters for the designated new-request scope and explicitly mapped original Root session scopes. Each registers one admitted constructor, consumes it once, accepts one fresh text input batch, advertises `batch-operations-v1`, and drains accepted judgments before process exit. Interrupted constructors/turns are not replayable.

Root uses each request's exact adopted ThreadService, shared capacity and native session file. `consultationOwners` maps original root session IDs to original scope IDs; an existing request without its original owner returns unavailable, never a replacement session. Cached terminal chosen replies need no new native owner. Admission/reply records stay in their existing private directories. Authorized transcript reads consult the exact private owner without copying history.

Request/consent databases each require detached adoption receipts and exclusive ownership locks.

Table-specific custodians retain their own exact detached receipts. Disjoint table claims share one physical flock. Only an active `acquireScopeOwnership` lease can subdivide its full database claim, and only for that scope's `SCOPE:watch` claim over the six `WATCH_CUSTODY_TABLES`; ThreadService does not access those tables. CoreDuties supplies the owning scope explicitly. The root-owned watch receipt adds exactly `tableSubdivision:{version:1,ownerScopeId,ownerAdoptionReceiptPath,ownerAdoptionReceiptSha256}`, binding the active parent's logical receipt path and SHA256 of its adopted raw bytes. A generic full-database owner, another scope, another feature/table set, a changed parent receipt, or a missing parent cannot lend custody. Watch drains retain the original physical flock after the parent lease closes; no replacement full owner can enter until every claim closes. The core reconciliation clock owns consent/request outboxes. Admin access requires unified principal/resource grants and the existing specialized capability. Only the chosen reply leaves the confidential session.

## Retained callback transports

`callbacks` is explicitly `{kind:"none"}` or `{kind:"retained",listeners:[...]}`. Each listener names `id`, `subsystem` (`root` or `memory`), exact loopback `host`/`port`, `previousOwner` identity and `detachmentReceiptPath`. Ports are distinct from each other and the canonical port. Root and memory integrations must already be configured.

A protected root-owned receipt binds `{version:1,state:"detached",listenerId,subsystem,host,port,previousOwner:{identity,detachedAt}}`. The old listener must drain before that receipt is issued and the port rebinds. Missing listeners or absent PIDs are not proof of detachment.

These are additional HTTP sockets in the same core process, forwarding exclusively to canonical embedded plugins. The memory port exposes only original memory/session/root-memory operations; the Root port exposes only original ask/admin operations. Each forwards its plugin's original health response and authentication unchanged; Root admin still passes through unified authorization. Neither can reach core/provider/image endpoints. Shutdown stops accepting and waits for accepted responses before stores close.

Retirement is explicit: after retained clients referencing an old URL have drained or advanced to current endpoints, remove that listener from the registered configuration; use `{kind:"none"}` when all are retired. An idle socket or elapsed time does not prove its clients are gone. There is no automatic timeout retirement.

## Verified owning gateways

`gatewayTransport` is explicitly `{kind:"none"}` with `gatewayBindings:[]`, or `{kind:"unix",socketDir:"/run/pi-stack/gateways"}` with registered bindings. Each binding names `{gatewayId,purpose:"core-ingress",peerUid,principalId,scopeIds,routeCeiling:[{method,kind:"exact"|"prefix",path}]}`. Its fixed socket is `GATEWAY_ID.sock`. The host configuration selects the principal; request headers cannot select one. Scope routes, images and the exact read-only usage/people-usage endpoints require explicit ceilings. Their actual resource grants remain independent.

Before Node HTTP sees a connection, the fixed `gateway-peer.py` helper reads Linux `SO_PEERCRED` from an inherited socket descriptor without consuming bytes. Only the configured kernel UID is admitted. `webRequest()` preserves that verified context for both unread and streamed request construction. Core authorization intersects gateway principal/scope/route ceilings with native thread capabilities and any separately supplied credential; it never promotes memory, provider, signing or unlock credentials. The owning Remote/router remains responsible for browser sessions, current room membership, revocation and full reply audiences. A room custodian's internal shared-scope custody is not a person's disclosure grant.

`unixGatewayFetch({socketPath,peerUid},input,init)` verifies the server's kernel UID before writing any request, supports streamed bodies/responses and abort, and introduces no secret or retry. It serves both directions. Core callbacks use the configured `scope.callbackGateway` and exact `/run/pi-stack/gateways/remote-SCOPE/callback.sock`; deployment prepares that scope's UID-owned protected directory below the root-owned parent. Remote owns a separate `purpose:"remote-callback"` binding with core UID and exact prepare-message/manager-relay ceilings. Ordinary TCP callbacks cannot acquire this verified context.

Core socket startup holds an exclusive resource-owner flock through bind, drain and unlink. Following a crash it removes a configured socket only after affirmative `ECONNREFUSED`, unchanged inode, exact owner and private mode. A live or uncertain listener is never unlinked. Kernel credential acquisition and socket lifetime are resources only, not another controller.

## Focused proof and deployment boundary

`tests/core-custody.test.ts` attaches synthetic old-generation sockets through a real process descriptor, checks unchanged store identity/bytes, rejects changed PID birth and unregistered paths, proves atomic private-batch rejection and accepted judgment drain, and transports a large frame through the fixed Python bridge. Root managed-session tests exercise the actual shared ThreadService/capacity, exact queued original request adoption, replay fencing, terminal reply reuse and missing-owner errors.

Deployment owns generation-transfer validation, namespace pins, FUSE resource custody and callback listeners. No live handoff, mounts, grants or service activation are part of these adapter changes.
