# Public application delegation

Maintained source: [`deploy/public-app`](../deploy/public-app/README.md).
This is source adoption of the already-running additive Martine public lane,
not a private Remote decomposition or a production activation. The existing
release owner (`cc4604c2-3a9b-4f0a-baab-97ad326678ba`) retains integration and
publication custody. Root commitment `martine-stack-production-isolation-20261010`
stays open for the remaining extraction and trusted-review work.

## Capability boundary

The dividing line is capability and data flow, not a directory name:

- Arbitrary delegated application bytes execute only as
  `pi-stack-public-martine`, with no login, sudo, capabilities or inherited owner
  identity, inside fresh PID/mount/user/network namespaces and no-new-privileges.
- The immutable gateway sees only its inherited credential-free loopback listener,
  public system libraries and the public application Unix socket. It never loads
  delegated source or reaches a private upstream.
- Any code/config able to unlock, decrypt, receive, render, cache or forward private
  material remains trusted. So does anything executed with owner/root authority
  or able to change that authority. This includes private key-entry/renderer UI,
  Android private client, auth/session router, supervisors, root companion,
  memory/key custody, private-agent tools/skills/dependencies and publishers.
- Fixed privilege/transport bridges, namespace/resource policy and ingress policy
  are trusted even though they accept application bytes. They must drop privilege
  before executing those bytes. Root/owner credentials never cross into the app.

Data flow: credential-free loopback HTTP → fixed confined gateway → single public
Unix socket → arbitrary isolated application. No personal homes, registries,
production dependency trees, decrypted payloads, owner credentials or private
control sockets are exposed. Never share this origin with private key/data UI or
submit arbitrary delegated source to the privileged private-app publisher.
Same-kernel isolation is not a VM or an exhaustive security proof.

## Installed profile and operations

Target `gmktec` means current Ubuntu **kenan-server**, not the retired hardware.
Target `converge` means the existing Converge host. Both serve
`http://127.0.0.1:8899`, bound to loopback only. The app owns
`/srv/pi-public/martine/{application,state,releases,ingress}`; namespace names are
`/work/{application,state,releases,ingress}`. `run` must listen on
`/work/ingress/app.sock`. The fixed app launcher runs
`/bin/sh /work/state/current/run`. Python, Node and Bun are exposed as public
execution dependencies, not the production dependency tree.

Martine's installed bridge interface:

```sh
sudo -n /usr/local/sbin/pi-stack-public gmktec check
sudo -n /usr/local/sbin/pi-stack-public gmktec exec /bin/bash
sudo -n /usr/local/sbin/pi-stack-public gmktec deploy
sudo -n /usr/local/sbin/pi-stack-public gmktec rollback
sudo -n /usr/local/sbin/pi-stack-public converge sync
sudo -n /usr/local/sbin/pi-stack-public converge fetch /health
```

Both targets admit `exec`, `check`, `deploy`, `rollback`, `start`, `stop`,
`restart`, `status`, and `fetch /PATH`; only `converge` admits `sync`. `exec`
accepts stdin, no interactive TTY. Local `deploy` snapshots regular application
files, switches current/previous and restarts only the public application.
`sync` streams local public application files through the fixed SSH bridge and
activates a remote snapshot. Links/devices, traversal, incomplete archives and
oversized deployments are rejected. These copies are mutable under the app
identity; they are not cryptographically immutable releases or trusted source.
`fetch` talks directly to the public socket, never a private API.

CLI work is limited to 1 GiB, 128 tasks, one CPU and 15 minutes. Aggregate slice
`pi-stack-public-martine.slice` bounds application, gateway and concurrent CLI
work to 2 GiB, 256 tasks and two CPUs. Application and gateway also have individual
limits. Trusted installed config is
`/etc/pi-stack/delegations/martine-public.json`. Runtime UIDs are host-generated;
source adoption records their actual values, not a portable UID assumption.
The local delegate UID 1004 is fixed in `control.py` and must match local custody.

Gateway admission rejects browser credentials, cross-origin/cross-site requests,
chunking and upgrades. Only fixed safe request headers reach the public app;
response cookies, redirects, CORS and app-supplied security headers do not return.
The fixed CSP gives HTML an opaque sandbox with no network, form, frame or
private-origin authority. HTTP negative/header tests do not establish browser or
phone behavior; those checks remain outstanding. Use a credential-free CLI or a
separate clean origin via SSH tunnel, never enter personal material.

## Source and evidence identities

[`identity.json`](../deploy/public-app/identity.json) binds the reviewed eight
source files and their installed executable destinations. Its unit hashes bind
the exact generated sandbox/resource configuration; installed config hashes bind
each host's observed config including verification metadata. `install.py` writes
the operational config, while the earlier root verification added its result
fields afterward. Config verification fields are historical claims, not a fresh
probe or executable authority.

[`installation-verification.json`](../deploy/public-app/installation-verification.json)
is the retained **30 passed installation checks** from October 10 UTC.
[`adoption-observation.json`](../deploy/public-app/adoption-observation.json)
is the later **read-only** identity, enabled/active service and `/health`
observation. Neither means this source commit was installed by normal publication.
The original installed source/proof stays under root's action custody; this
adoption changes no canonical release selector, private service or publication
request. The bounded source tests require no dependency installation or privileged
host effects. See the [source README](../deploy/public-app/README.md) for commands.

## Remaining end states and owners

Root Kenan retains the full production-isolation commitment; the current source
and publication owner carries one combined integration, not a new release lane.

1. **Existing-app classification and extraction:** classify Remote routes, client
   bundles and their dependencies by the capability rule above. Extract remaining
   genuinely public-only portions so they can be replaced arbitrarily in this
   isolated lane. Keep private UI and auth/data channels on independently
   controlled services/origins; no decrypted payload enters untrusted modules.
2. **Trusted exact-change review:** provide an identity-bound review/activation
   path for secret-consuming or elevated changes, then use normal existing
   publication. Full-source editing is not arbitrary private execution authority.
3. **Maintained activation custody:** integrate this fixed deployment profile into
   the owning source/publication lane after trusted review, with explicit host
   config, installed source/config/unit identities and independent both-host
   receipts. This adoption preserves reviewed installed bytes but does not wire
   the installer into shared deployment or assert normal-release delivery.
4. **Consumer proof:** establish actual clean-origin browser/phone behavior and a
   leased, identity-bound live verification/restoration contract before replaying
   mutable application fixtures.

The existing independent full-source workspace and staging grant remain separate.
This additive docs/app lane does not claim full current private-app decomposition.
