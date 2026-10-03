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
`node`. Publish these sources before cutover. The fixed root SDK waits for the encrypted mount
before creating its agent/session directories. Rooms receive only public model metadata and
broker settings, not private contexts, packages, keys or root credentials.

`spaces` lists any additional explicit root read/write spaces, as
`{"path":"/absolute/path","owner":"original-user","recursive":true,"access":"rwX"}`.
Registered encrypted folder ciphertext and mountpoint traversal are added automatically.
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

From the selected committed release checkout (on kenan-server this is
`/home/kenan/.local/state/pi-stack-release/repository`):

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

Use the same plan and transaction directory for every step. A second transaction will not
adopt existing service accounts or overwrite existing additive config. Interrupted cutover
requires rollback, not another cutover. Partial failure rolls back automatically.

Cutover starts only `pi-kenan-access`, `pi-kenan-broker`, `pi-kenan-custody`,
`pi-kenan-memory`, `pi-kenan-root`, `pi-rooms` and the journal timer. Custody starts sealed;
the first successful enrolled login opens all enrolled folders in its private mount namespace.
Existing personal login remains owned by the original router path and captures custody
nonfatally. Missing folder keys are captured on their next successful login.

Original supervisors get additive credential drop-ins, applied at their next **ordinary**
start. Memory's verified original-UID mapping supplies identity to already-running supervisors
meanwhile. The router likewise gets future room URL/database environment settings; the default
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

Custody, root, memory and journal units set `MemorySwapMax=0` and `LimitCORE=0`. Their
private contexts and unlocked keys must not spill into the host's unencrypted swap or a core
dump. Custody's owner-run gocryptfs children remain in its no-swap cgroup. This policy is
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
```

The nine tests use temporary people, paths, configs and command stubs. The privileged rehearsal
runs them foreground under `unshare --mount --propagation private`; no live unit, `/etc`, key,
firewall or folder mount is touched. They prove preparation has no host effect, no user-service
handoff, dedicated broker ownership, private root credentials, unprivileged room isolation,
exact flag/config/ACL restoration, data preservation, bounded partial-failure rollback,
failed-stop gate retention, fixed-prompt installation and mask-safe additive ACLs. Printed nft rules prove old ports/gates are untouched. This is deployment
transaction proof, not a claim that real systemd/FUSE or the complete product has been exercised;
S5 custody and the integrator's encrypted staging stack own those acceptance tests.
