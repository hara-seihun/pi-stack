# Configuration and public source

Pi Stack ships code, reference units and examples. A deployment supplies its own accounts, endpoints and credentials.

## Configuration owners

| Configuration | Owner |
| --- | --- |
| Fleet account, endpoint catalog, extra packages and skills | `/etc/pi-stack/host.json` |
| Repository, publication identity, deployment targets and paths | `/etc/pi-stack/publication.json`, starting from [the example](../config/publication.example.json) |
| Person identity, encrypted folder, workspace paths, models and grants | `/var/lib/pi-remote/persons/USER.json`, managed by `pi-remote person` |
| Development checkout, executable path and allowed browser hostnames | `/etc/pi-stack/dev-remote-USER.env`, starting from [the example](../apps/remote/dev-remote.env.example) |
| Android bootstrap router URL and local SDK path | ignored `apps/kenan/android/local.properties`, starting from [the example](../apps/kenan/android/local.properties.example) |
| Model-provider credentials | the host's Orchestrator account store and broker configuration |
| Voice API credential | host-provisioned systemd credential, described in [deployment](deployment.md) |
| Router sign-in, tunnel identities, local model endpoints and TURN settings | host-owned service configuration |

Never commit the filled-in files, private session recordings, signing keys or built APKs containing local endpoints. Public examples use fictional identities. Product names and package IDs are not deployment account names.

Reference services use `/srv/pi` as the installation layout. Deployment destination environment variables support rehearsals in separate directories. The [deployment guide](deployment.md) describes installation, release selection and authenticated smoke checks.

## Contributions and checks

There is no GitHub Actions workflow or self-hosted runner attached to this public repository. Opening a pull request does not execute its code on a deployment host. Maintainers review external source before accepting it into their trusted publication queue. Changing a workflow in a pull request does not grant host access.

Run `npm ci --ignore-scripts` and `npm run check` in an environment appropriate for the source being evaluated. Run Android checks with the host's local build configuration. The configured publication owner runs the integration checks and records the exact commit, commands, artifacts, deployment results and service proof.

## Public history

The public history begins with a source snapshot. Private development transcripts, household configuration and GitHub job logs are not included. The source owner retains prior development provenance privately, including the original commit and the snapshot's tree identity. Do not merge pre-publication branches into this repository. Reapply an outstanding change onto current public `main`, then review it as an ordinary source change.

Vendored dependencies keep their upstream licenses and source receipts in [vendor/pi](../vendor/pi/README.md). The root [license](../LICENSE) applies to first-party source.
