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
| Router sign-in, tunnel identities and local model endpoints | host-owned service configuration |

Never commit the filled-in files, private session recordings, signing keys or built APKs containing local endpoints. Public examples use fictional identities. Product names and package IDs are not deployment account names.

Reference services use `/srv/pi` as the installation layout. Deployment destination environment variables support rehearsals in separate directories. The [deployment guide](deployment.md) describes installation, release selection and authenticated smoke checks.

## Contributions and checks

There is no GitHub Actions workflow or self-hosted runner attached to this public repository. Opening a pull request does not execute its code on a deployment host. Maintainers review external source before accepting it into their trusted publication queue. Changing a workflow in a pull request does not grant host access.

Submit the exact committed source to the configured publication owner. That SHA is the delivery candidate; a later `main` neither replaces it nor requires it to qualify again. Source-history admission still protects public roots, retained owner repairs and each host's selected history.

On kenan-server, publication builds the required artifacts and deploys immediately, with service-start recovery only: zero tests, doctors, qualification, warm-up or browser gates. Converge owns an independent `minimal` lane with changed-source builds and actual service/source health; kenan-server uses `immediate` mode and full post-serving diagnostics use `qualified` mode. It cannot delay or roll back kenan-server. Tests, proofs and doctors outside that minimal remote lane run after serving and record their actual outcomes, not a global success gate. [Checks](checks.md) describes source-bound verdict reuse; [deployment](deployment.md#publication-owner) owns delivery and repair.

## Client before server activation

Each host installs its matching APK/web artifact **before activating its server**. An older mobile bundle may reject a new server state and show an empty directory; the matching bundle must already be downloadable when that server changes. Existing open clients still need to apply the update. Artifact hashes establish transfer integrity, not a test or qualification gate.

`deploy/android-update bundle FILE` packages the installer and its validators into one portable Bun script. Publication transfers it with the artifact and verifies its hash before use, without changing the remote server checkout or rollback selection. An artifact failure affects only that host. Retries reuse immutable bytes and retain successful delivery elsewhere.

Each durable host outcome records the exact candidate, artifacts and serving result. Its reservation ends when its own delivery finishes, rather than after fleet completion. A meeting, native-history prerequisite, lock, transfer failure or activation failure on Converge never delays kenan-server. Failed hosts receive bounded automatic retry and an alert naming the host, source and failure; successful peers are not replayed or rolled back. Reports distinguish serving hosts, pending or failed hosts, and post-serving check outcomes instead of collapsing them into a global green result.

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

The worker records boot identity, command progress and immutable source refs so
restart recovery can distinguish an interrupted command from a completed effect.
Recovery inspects retained effects before retrying; it resumes the same request
and exact candidate. Moving `main` is not permission to replace or requalify an
in-flight source. Per-host recovery retains successful peer delivery and native
restoration custody. Failure, cancellation and exhausted recovery remain explicit
outcomes, with their command evidence and repair owner.

## Public history

The public history begins with a source snapshot. Private development transcripts, household configuration and GitHub job logs are not included. The source owner retains prior development provenance privately, including the original commit and the snapshot's tree identity. Do not merge pre-publication branches into this repository. Reapply an outstanding change onto current public `main`, then review it as an ordinary source change.

Vendored dependencies keep their upstream licenses and source receipts in [vendor/pi](../vendor/pi/README.md). The root [license](../LICENSE) applies to first-party source.
