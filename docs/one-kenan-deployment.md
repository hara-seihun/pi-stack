# Root Kenan deployment owner

`deploy/one-kenan` provisions the **root-Kenan revision**, not shared-UID user supervisors.
The existing router, per-person supervisors, Orchestrators, ordinary broker and SSH identity
stay in place. Preparation changes only the transaction directory. Authorized cutover adds
service accounts, private root custody/runtime, unprivileged rooms, a separately scoped model
broker, new-listener UID gates, memory/journal credentials and the host flag. It never stops,
restarts or switches an existing user service. This is separate from source publication.

## Host plan

Provision a root-owned, non-group/world-writable plan. If the configured root prompt is
absent, cutover installs the fixed `instructions.md` from the published root runtime as a
root-owned file; an existing prompt must be root-owned and non-group/world-writable. No credential values
belong in the plan; custody generates random credentials into root-only files. Example
`/etc/pi-stack/one-kenan-plan.json` (the model must exist in this host's broker grants):

```json
{
  "version": 1,
  "executionUser": "pi-kenan",
  "roomsUser": "pi-rooms",
  "hostFile": "/etc/pi-stack/host.json",
  "personsDir": "/var/lib/pi-remote/persons",
  "brokerSource": "/etc/pi-model-broker.json",
  "orchestratorConfig": "/var/lib/pi-orchestrator/config.json",
  "memoryPort": 18820,
  "rootPort": 18821,
  "roomsPort": 18822,
  "rootBrokerPort": 2480,
  "roomsBrokerPort": 2481,
  "root": {
    "provider": "openai-codex",
    "model": "gpt-6.1-sol",
    "thinkingLevel": "high",
    "promptFile": "/etc/pi-stack/kenan-root.md"
  },
  "spaces": []
}
```

`brokerUser` defaults to the host's `fleetUser`. `brokerAccounts`/`brokerModels` may restrict
the pool; by default they are the union of existing explicit host broker grants. The separate
broker config has `grantOwner: "one-kenan"` and two principals, `pi-kenan` and `pi-rooms`.
It uses the existing operator ledger/auth paths, never copied OAuth credentials. The deployed
broker must support named grant ownership before activation; the old broker config is unchanged.

Public runtime path overrides are `remoteRoot` (`/srv/pi/pi-remote`), `rootRuntime`
(`/srv/pi/pi-remote/kenan-root`), `memoryRuntime` (`/srv/pi/runtime/node_modules/kenan-memory`), `orchestratorRoot`
(`/srv/pi/pi-orchestrator`), `modelCatalog` (the orchestrator's `dist/models.json`), `bun` and
`node`. `toolsRoot` defaults to `/srv/pi/tools`; cutover routes the known
`/home/kenan/tools/mail-send/main`, registered people/operator `~/.local/bin/mail-send`,
and existing `~/tools/mail-send/main` paths to its `mail-send/main`. `mailSendRoutes` can
add other absolute command routes. Original file bytes/mode/ownership and symlink targets
are saved in the transaction and restored on rollback. Publish these sources before cutover. The fixed root SDK waits for the encrypted mount
before creating its agent/session directories. Rooms receive only public model metadata and
broker settings, not private contexts, packages, keys or root credentials.

`spaces` lists any additional explicit root read/write spaces, as
`{"path":"/absolute/path","owner":"original-user","recursive":true,"access":"rwX"}`.
Registered encrypted folder ciphertext and mountpoint traversal are added automatically.
On hosts with `/etc/apparmor.d/fusermount3`, cutover appends an exact shared-store mount
and umount grant to `/etc/apparmor.d/local/fusermount3` and reloads the profile. Existing
local-file bytes are preserved, including unrelated rules, and restored byte-for-byte
on rollback (or the newly created local file is removed), followed by another reload.
Hosts without that profile are untouched.

ACL grants preserve all other principals' **effective** rights when expanding an ACL mask;
original-owner default ACLs keep new ciphertext owner-accessible. Each cipher root also gets
an explicit named original-owner `rwx` ACL: the forced-owner FUSE view needs that entry to
validate the original daemon owner's access. The fixed root custody helper mounts each folder
through its original owner with `-acl -allow_other -force_owner PI_KENAN_UID:GID`. Only the
root FUSE view changes ownership; backing files and new ciphertext remain owned by the original
daemon owner, and concurrent original personal mounts keep their unchanged view. No file tree is re-owned, and no SSH directory
is included. Hara's own existing Converge tool keeps using her existing SSH identity.

Optional `credentialTools` maps `pass-cli`, `mail-send`, `mail-search`, `github`, or
`git-credential` to absolute operator commands. Only `pi-kenan` receives the fixed sudo bridge;
ordinary people and `pi-rooms` do not. `github` excludes auth/config/alias/extension operations.
No bridge is installed if this map is absent.

## Prepare, activate, roll back

From the host's selected committed release checkout (normally
`~/.local/state/pi-stack-release/repository` for the publication account):

```sh
sudo deploy/one-kenan prepare \
  --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy

# Only after Hara authorizes the reversible cutover:
sudo deploy/one-kenan cutover --authorize-cutover \
  --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy

sudo deploy/one-kenan status \
  --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy

sudo deploy/one-kenan rollback --authorize-cutover \
  --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy
```

Host commands must run in PID 1's mount namespace. A person supervisor's namespace
is refused before reading configuration or creating transaction state; rerun through
`sudo nsenter -t 1 -m --` with an absolute CLI, config and state path. Fixtures remain
inside their staging namespace.

Use the same plan and transaction directory for every step. A second transaction will not
adopt existing service accounts or overwrite existing additive config. Interrupted cutover
requires rollback, not another cutover. Partial failure rolls back automatically.

Fixed custody startup first confirms its mount namespace differs from the host's PID1
namespace, makes its own propagation private, and lazily detaches only exact registered
`fuse.gocryptfs` folder mountpoints inherited from personal services. It never unmounts the
host namespace or signals a personal daemon. Custody then creates its own same-path owner
mounts when validating keys; personal services retain their original live views.

Existing registered `/run/pi-remote-keys/USER` credentials are collected on startup, without
requiring people to log out or re-enter a key. Only root-owned private regular files in a
root-owned private nonsymlink directory are admitted (`O_NOFOLLOW`, single hardlink, bounded
size). Each key must successfully open its FUSE folder before encrypted custody retains it.
No old key file is removed, and no key goes into argv/logs. `PI_REMOTE_KEY_DIR` selects a
fixture-only directory in rehearsals. After reboot the empty `/run` still requires the first
enrolled human login to reopen custody; a not-yet-collected key is captured on its next login.

Cutover starts only `pi-kenan-access`, `pi-kenan-broker`, `pi-kenan-custody`,
`pi-kenan-memory`, `pi-kenan-root`, `pi-rooms` and the journal timer. Custody starts sealed;
the first successful enrolled login opens all enrolled folders in its private mount namespace.
Existing personal login remains owned by the original router path and captures custody
nonfatally. Missing folder keys are captured on their next successful login.

Original supervisors get additive credential drop-ins, applied at their next **ordinary**
start. Memory's verified original-UID mapping supplies identity to already-running supervisors
meanwhile. A missing implicit `kenan-memory-supervisor` in an existing
`CREDENTIALS_DIRECTORY` is optional; an explicitly configured missing token file or any
other credential-read failure remains an error. The router likewise gets future room URL/database environment settings; the default
production paths match them without an immediate restart. Custom ports require the staging
router's matching environment. No deployment helper requests an existing-service restart.

Rollback restores the exact original host bytes and saved ACLs/config files, stops only new
units and removes only the additive firewall table. It clears
`Store.publishBrokerGrants([], "one-kenan")` after stopping the separate broker, never ordinary
grants. Ciphertext, credentials, new service-account UIDs, room data and transaction evidence
stay in custody; accounts have `nologin` shells. No user folder is unmounted or re-owned by the
CLI. If an additive process cannot stop, rollback reports failure and retains its gates/config
for repair rather than opening an ungated privileged listener. The original front door stays up.

## Units and data

Mount namespace sharing is implemented by `/usr/local/libexec/pi-kenan-runtime`, not
`JoinsNamespaceOf` (systemd's directive does not share mount namespaces). Root, memory and
journal retain `User=pi-kenan` for credential ownership; `ExecStart=+` runs only the fixed
root-owned launcher with one static role. It verifies custody's root MainPID and exact helper
source, opens/pins that process's distinct mount namespace, calls `setns`, drops UID/GID/groups,
and execs the host-configured role source as `pi-kenan`. It accepts no arbitrary command.

Before joining, systemd credential contents are copied into sealed RAM-only memfds owned by
the runtime UID, with their corresponding file environment variables pointing at inherited
`/proc/self/fd/N`. This is necessary because the original systemd credential mounts may not
exist in custody's namespace. No credential value goes into argv, environment, or disk copies.
Root/memory wait for custody's encrypted FUSE mount *in that actual shared namespace*;
journal checks that mount after joining and skips draining while sealed. `BindsTo` still stops
consumers if custody stops. Future FUSE mounts made by custody are visible to joined runtimes.

Custody, root, memory and journal units set `MemorySwapMax=0` and `LimitCORE=0`. Their
private contexts and unlocked keys must not spill into the host's unencrypted swap or a core
dump. Root, memory and journal set `BUN_INSTALL=/var/lib/pi-kenan/bun` and
`BUN_INSTALL_CACHE_DIR=/var/lib/pi-kenan/bun/install/cache`. Root also sets
`HOME=/var/lib/pi-kenan/home`: Bun can create `$HOME/.bun/install/cache` before
custody mounts even with those explicit Bun settings. Cutover creates the home and
Bun cache trees as `pi-kenan`, mode `0700`, outside the shared private mountpoint;
gocryptfs requires that mountpoint to remain empty before mounting. Root's configured
`cwd`, `agentDir` and `sessionsDir` stay inside the encrypted private store. Home and
cache directories remain on rollback, like other retained state under `/var/lib/pi-kenan`;
they are not private personal state and remain outside the cipher.
Custody reports each rejected retained person with the specific failure and captures
bounded, key-redacted gocryptfs stderr; a shared-store mount failure is not described as
a need for another login.

Custody's owner-run gocryptfs children remain in its no-swap cgroup. This policy is
additive to these new services only; no original user's live unit or host swap is changed.

- `pi-kenan-custody.service`: root, fixed helper only, root-only socket `/run/pi-kenan/custody.sock`.
  It deliberately has no `StateDirectory=pi-kenan`: systemd must not recursively re-own
  the `pi-kenan`-owned `.private.crypt` and `private` directories when starting root custody.
- `pi-kenan-root.service`: `pi-kenan`; joins custody's private namespace, reads
  `kenan-memory-root` and `kenan-root-admin` through systemd credentials. Admin capability is
  64 lowercase hexadecimal characters in `/var/lib/pi-kenan/root-admin-capability`.
  Consent uses a distinct random 64-hex `rootConsentCapabilityFile` (default
  `/var/lib/pi-kenan/root-consent-capability`), root-only `0600`, delivered solely to the
  root runtime as `kenan-root-consent` through systemd credentials. Persons and rooms never
  receive it. `PI_KENAN_ROOT_CONSENT_TOKEN_FILE=%d/kenan-root-consent` and
  `PI_KENAN_ROOT_ROUTER_URL=http://127.0.0.1:routerPort` configure root→router consent;
  `routerPort` defaults to the existing router's `8788`. The router reads capability/config
  dynamically, without a restart. Consent SQLite is inside encrypted
  `/var/lib/pi-kenan/private/root/consent.sqlite3`, never the public roster or deployment state.
- `pi-kenan-memory.service`: `pi-kenan`; joins custody, reads auth config through credentials.
- `pi-kenan-journal.timer/service`: `pi-kenan`; joins custody, publisher credential, encrypted store.
- `pi-rooms.service`: separate `pi-rooms` identity, no custody namespace/key/private access,
  no-new-privileges, its own `/var/lib/pi-rooms` store and fixed room memory credential.
  Root Kenan gets recursive read-only `r-X` ACL access to that shared room runtime state,
  plus directory default `r-x` ACLs for new state. Room custody retains write authority;
  ordinary people gain no filesystem grant. This built-in owner grant lets privileged Kenan
  diagnose a room without importing its contents into a person's transparent thread.
  Native/custody atomic replacements preserve existing file modes; new room native files
  use `0640` so the inherited observer ACL remains effective. Ordinary new private files
  remain `0600`. Granting defaults alone is insufficient if a replacement forces `0600`.
- `pi-kenan-broker.service`: original operator identity, additive principal-scoped listener grants.
- `pi-kenan-access.service`: root oneshot, separate `inet pi_one_kenan` table. No ordinary
  port rule is widened. Root/room broker ports admit only root and their corresponding service;
  memory/root request listeners admit verified original-person UIDs plus the new services.
  Room-owner HTTP admits root router only. All new ports reject non-loopback ingress.

`/etc/pi-stack/one-kenan.json`, `kenan-root.json`, `rooms.json`, `one-kenan-broker.json` and
`one-kenan-access.json` are CLI-owned additive config. `/var/lib/pi-kenan/custody/keys.json`
holds wrapped encrypted keys, not plaintext secrets; `/var/lib/pi-kenan/.private.crypt` owns
shared encrypted state. `/var/lib/pi-remote/one-kenan` is root-owned, root-group-readable room
roster attestation; it is not a channel to private memory. The transaction directory is root-only
and includes private credential/config restoration evidence; do not publish its contents.

## Seconds-long fixture proof

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/one-kenan-deploy.test.py
sudo deploy/one-kenan-rehearse
sudo deploy/one-kenan-fuse-rehearse
sudo deploy/one-kenan-namespace-rehearse
```

The deployment tests use temporary people, paths, configs and command stubs. The privileged rehearsal
runs them foreground under `unshare --mount --propagation private`; no live unit, `/etc`, key,
firewall or folder mount is touched. They prove preparation has no host effect, no user-service
handoff, dedicated broker ownership, private root credentials, unprivileged room isolation,
exact flag/config/ACL restoration, data preservation, bounded partial-failure rollback,
failed-stop gate retention, fixed-prompt installation and mask-safe additive ACLs. Printed nft rules prove old ports/gates are untouched. This is deployment
transaction proof, not a claim that the complete product has been exercised.
`one-kenan-fuse-rehearse` adds genuine gocryptfs proof: two active personal mounts inherited
at the exact registered paths are replaced only inside a nested custody namespace; retained
fixture keys bootstrap encrypted custody; root writes remain readable/writable by the original
namespace after custody exits; an empty retained-key directory stays sealed until Bob logs in.
The separate namespace rehearsal starts a real runtime under a dropped fixture UID before
custody creates its FUSE mount: it then observes and reads the later mount, reads its sealed
credential across setns/exec, and proves the original namespace never receives that mount.
The integrator's staging stack owns the complete-product acceptance tests.

## Explicit consumer release activation

`deploy/host` refreshes the installed `pi-kenan-access` command and its additive nft table on enabled hosts, then invokes the normal One Kenan activator. The activator replaces stale memory/Root consumers and rolls rooms, proving each startup commit. Encrypted custody remains running. Room self-instructions access is restricted to root and the room UID; root executor access to room state is a separate read-only filesystem grant.

After selecting committed Remote source, a room-only rolling handoff needs no root migration and touches no memory/root service. Health probes treat connection resets, early disconnects and incomplete/malformed responses during listener replacement as unavailable, just like connection refusal. Readiness still requires the expected startup commit and `ok:true` within the existing 40-second budget; persistent failures defer rather than accept a release or kill active work. This covers the room handoff reset that failed publication `PUB-ef31f4591b7a483ca18022a5` after the replacement listener was already starting.

A room-only handoff:

```sh
sudo python3 deploy/one-kenan-activate rooms --host /etc/pi-stack/host.json --expected COMMIT
```

After selecting the committed runtime/Remote sources, install the current fixed namespace launcher and explicitly activate all consumers:

```sh
sudo install -m 755 deploy/one-kenan-runtime /usr/local/libexec/pi-kenan-runtime
sudo python3 deploy/one-kenan-activate check --host /etc/pi-stack/host.json --expected COMMIT
sudo python3 deploy/one-kenan-activate activate --host /etc/pi-stack/host.json --expected COMMIT
sudo python3 deploy/one-kenan-activate proof --host /etc/pi-stack/host.json --expected COMMIT
PYTHONDONTWRITEBYTECODE=1 python3 scripts/one-kenan-activate.test.py
node --test scripts/one-kenan-access-release.test.mjs
```

The helper accepts custom listener/runtime paths from the root-owned `/etc/pi-stack/one-kenan.json`; `--config` overrides that file. Activation/proof never opens private stores, sessions or encrypted custody. Disabled hosts change nothing. Activation runs in PID 1's mount namespace and holds an administrator-only activation lock.

Root exposes startup `releaseCommit`, `releaseProtocol:2` and aggregate execution/consent counters. The separately authenticated `POST /v1/admin/release` returns 409 while work is active, without changing admission or cancelling execution. At natural idle it pauses executor dispatch and consent reconciliation only. Normal asks remain authenticated, durably accepted and retrievable with their original request IDs; queued receipts carry `executor-handoff`. `DELETE` resumes dispatch. A running owner without this graceful accepting protocol is left untouched and activation returns 75; this is not a native-history preflight requirement.

The activator pauses dispatch only immediately before stale consumer replacement. Memory finishes accepted HTTP before SQLite closes. Root's main-only SIGTERM pauses new dispatch, waits for active asks and consent reconciliation while continuing to accept queued asks, then drains accepted HTTP and closes stores. Its mixed kill mode and infinite stop timeout prevent a readiness timeout from killing accepted native work. Queued asks and durable consent receipts survive in their existing stores and the next owner resumes them without admitting another consultation. Exact-ID clients reconnect across the brief listener swap rather than inventing acceptance or resubmitting a new request.

Root/memory/journal launchers pin their source and record the selected commit before dropping privilege. The helper's 40-second readiness budget bounds its observation, not systemd's graceful drain. Pending readiness remains pending. The history adapter is observational throughout preparation and never establishes a Root admission journal or gate.

Rooms use the existing `pi-remote-supervise` rolling handoff, so active runtime hosts keep running and the replacement supervisor adopts them without replay. The helper installs a room-only launcher drop-in. For an existing direct-Bun room unit, it temporarily sets `KillMode=process`, sends `SIGUSR2` to only the legacy main PID, and waits for a new main PID **and** expected startup health before removing that migration drop-in. Later handoffs keep `KillMode=control-group` for deliberate service shutdown. A failed first handoff retains its migration setting for repair rather than killing active hosts. Ordinary users' units are untouched.

`proof` checks each consumer's live HTTP startup commit, not selected symlinks or service start times. Its output contains only role/unit/revision metadata. Successful enabled-host activation includes Root, memory and rooms; a pending consumer handoff is not a successful host release.

### Person-scoped implicit execution model

An owner's nonsecret person registry may opt into `environment.PI_THREAD_DEFAULT_MODEL`
with a catalogue or provider/model selection. Remote, the person's Orchestrator (including
isolated owners), and new schedules read this owner setting at admission. It replaces
only an omitted non-mode model, including notification/consent inboxes; explicit
models, declared mode choices (including permitted live Luna), global availability, accepted receipts, existing schedules
and running executions remain unchanged. Rooms have no personal override. With no opt-in,
all previous defaults are retained. An unreadable/malformed registry fails admission closed.
Inbox payloads and request IDs are unchanged, so durable outboxes reconcile using the
same custody rather than new sends. Updating this setting alone requires no restart.
