# Configuration and public source

Pi Stack ships code, reference units and examples. A deployment supplies its own accounts, endpoints and credentials.

## Configuration owners

| Configuration | Owner |
| --- | --- |
| Fleet account, endpoint catalog, extra packages and skills | `/etc/pi-stack/host.json` |
| Repository, publication identity, deployment targets and paths | `/etc/pi-stack/publication.json`, starting from [the example](../config/publication.example.json) |
| Person identity, encrypted folder, workspace paths, models and grants | `/var/lib/pi-remote/persons/USER.json`, managed by `pi-remote person` |
| Development checkout, executable path and allowed browser hostnames | `/etc/pi-stack/dev-remote-USER.env`, starting from [the example](../apps/remote/dev-remote.env.example) |
| Android private/public bootstrap router URLs and local SDK path | ignored `apps/kenan/android/local.properties`, starting from [the example](../apps/kenan/android/local.properties.example) |
| Model-provider credentials | the host's Orchestrator account store and broker configuration |
| Voice API credential | host-provisioned systemd credential, described in [deployment](deployment.md) |
| Router sign-in, tunnel identities, local model endpoints and TURN settings | host-owned service configuration |

Never commit the filled-in files, private session recordings, signing keys or built APKs containing local endpoints. Public examples use fictional identities. Product names and package IDs are not deployment account names.

Reference services use `/srv/pi` as the installation layout. Deployment destination environment variables support rehearsals in separate directories. The [deployment guide](deployment.md) describes installation, release selection and authenticated smoke checks.

## Contributions and checks

There is no GitHub Actions workflow or self-hosted runner attached to this public repository. Opening a pull request does not execute its code on a deployment host. Maintainers review external source before accepting it into their trusted publication queue. Changing a workflow in a pull request does not grant host access.

Run `npm ci --ignore-scripts` and `npm run check` in an environment appropriate for the source being evaluated. Run Android checks with the host's local build configuration. The configured publication owner runs the integration checks and records the exact commit, commands, artifacts, deployment results and service proof.

## Client before server activation

After source integration and checks, publication delivers independently to each ready host. It installs and verifies that host's matching APK/web artifact **before activating that host's server**, not before activating every server. A meeting, native prerequisite, lock, transfer failure or activation failure on one host never prevents another ready host's client and server delivery. An older mobile bundle may reject a new server state and show an empty directory; the matching bundle must already be downloadable when that server changes. Existing open clients still need to apply the update.

`deploy/android-update bundle FILE` packages the checked installer and its validators into one portable Bun script. Publication transfers it with the artifact and verifies its hash before use, so publishing the client does not require changing the remote server checkout or its rollback selection. An artifact failure prevents only that host's server activation. Retries reuse the immutable APK/web bytes and retain successful delivery elsewhere.

Each host's durable outcome records source, artifact and service proof. Its reservation ends after that proof, rather than after fleet completion. Newer checked requests may advance ready hosts while an older request waits remotely; the older request accepts valid checked descendant source and matching-artifact proofs instead of reinstalling its older bundle or requiring an exact selected SHA. Full success still means every configured host has the requested source or a checked descendant and valid matching artifacts. A source marker alone does not establish delivery.

## Publication transport custody

The publication command boundary disables SSH connection sharing for every remote
operation, including rsync's remote shell. Each command owns its connection for
its bounded lifetime. A configured shared master can belong to an unrelated
thread's systemd scope; stopping that scope previously cut a release off with
exit 255 during preparation. Releases, host proofs and recovery must not inherit
that other owner's connection lifetime. Host authentication configuration remains
unchanged. A transport failure remains an explicit failure of that target's delivery,
with its command log and repair/retry custody; it does not undo another host's
proved delivery or prevent ready targets from advancing.

## Worker reboot recovery

The worker records the kernel boot identity when an attempt starts. A different
boot may resume an interrupted `integrate-main` or `confirm-integrated-main`
within that attempt, only with passed integration checks and no host custody.
The watchdog leaves that recovery to the worker rather than treating deadlines
from the previous boot as command stalls. The receipt retains each interrupted
command and both boot identities; at most three such recoveries are admitted.

Recovery fetches main before acting. If the push already reached main it is not
repeated; if main is still the checked base the immutable integration can be
pushed. Changed main retains the previous integration and its evidence under a
source ref and requires fresh integration checks. Incomplete checks, absent boot
identity, same-boot interruptions, exhausted reboot recovery and host-stage
interruptions keep their existing failure and repair custody. Reboot recovery
never revives a failed or cancelled publication.

## Public history

The public history begins with a source snapshot. Private development transcripts, household configuration and GitHub job logs are not included. The source owner retains prior development provenance privately, including the original commit and the snapshot's tree identity. Do not merge pre-publication branches into this repository. Reapply an outstanding change onto current public `main`, then review it as an ordinary source change.

Vendored dependencies keep their upstream licenses and source receipts in [vendor/pi](../vendor/pi/README.md). The root [license](../LICENSE) applies to first-party source.
