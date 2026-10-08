# First global-capacity cutover

The first deployment is not an ordinary release. Old producers do not know the global authority. New producers refuse execution until that authority is initialized. The cutover therefore replaces every old admission source **before** taking the census, while already accepted managed native runners continue.

`deploy/capacity-bootstrap-submit` submits one durable systemd job. It owns both-host source preparation, barrier verification, census, seed, guarded doctors and completion receipts. It does not submit normal publication or claim its later integration commit. Source bootstrap and final publication remain separate results.

## Execute on an immutable candidate

Prepare a root-owned candidate template and the per-host inventory plans, push the full candidate, and invoke from its checkout:

```sh
candidate=$(git rev-parse HEAD)
deploy/capacity-bootstrap-submit /etc/pi-stack/agent-capacity-bootstrap.json "$candidate"
```

This returns the unit, append-only log and receipt directory immediately. The unit's `ExecStopPost` writes a fsynced receipt for each systemd invocation. The source job and receipts are under `/var/lib/pi-stack/agent-capacity/bootstrap/jobs/COMMIT`; `deploy/capacity-bootstrap-candidate.mjs` is copied from the exact candidate, not a mutable working tree. Read the named unit's result/log and the generated `bootstrap.json` phase. Only `opened` plus a successful job receipt permits ordinary publication submission. Its integration will be a descendant of the candidate, not the candidate SHA relabelled.

The candidate driver runs each host's existing release wrapper with `PI_STACK_HOST_PHASE=publication`. This retains source and prepares/selects immutable artifacts without doctors or controller activation. Long preparation belongs to this durable job, not an attended tool call. Source/activation hooks after preparation have bounded deadlines. Interrupted or failed hooks retain the barrier ledger; resume the same template/candidate rather than clear authority custody or restore old producers.

## Candidate template

All paths and identities are explicit. `operatorUser` selects the administrator's own SSH profile even though the initializer runs as root. `sshAlias: null` identifies the one local authority host; no runtime host names or credentials are embedded in source.

```json
{
  "version": 1,
  "operatorUser": "operator",
  "barrierId": "first-global-capacity",
  "stateRoot": "/var/lib/pi-stack/agent-capacity/bootstrap",
  "authorityModule": "/srv/pi/pi-orchestrator/dist/agent-capacity-authority.js",
  "authorityConfig": "/etc/pi-stack/agent-capacity-authority.json",
  "hosts": [
    {
      "id": "host-a", "sshAlias": null,
      "releaseWrapper": "/home/operator/machine/pi-stack-release",
      "checkout": "/home/operator/.local/state/pi-stack-release/repository",
      "preparedHostPlan": "/etc/pi-stack/host-a.capacity.prepared.json",
      "hostPlan": "/var/lib/pi-stack/agent-capacity/bootstrap/host-plan.json"
    },
    {
      "id": "host-b", "sshAlias": "host-b",
      "releaseWrapper": "/home/operator/machine/pi-stack-release",
      "checkout": "/home/operator/.local/state/pi-stack-release/repository",
      "preparedHostPlan": "/etc/pi-stack/host-b.capacity.prepared.json",
      "hostPlan": "/var/lib/pi-stack/agent-capacity/bootstrap/host-plan.json"
    }
  ]
}
```

The driver regenerates each prepared host plan with the **actual candidate commit** and its release-owned checkout. It constructs the phase commands itself. The host owner supplies inventories, not fabricated success certificates.

## Host operations

`node deploy/capacity-host.mjs OPERATION /absolute/HOST_PLAN.json` implements:

- `prepare`: existing dependency preparation and code-only publication; run under durable custody. The candidate driver uses the owning release wrapper for this.
- `gate`: install the prepared UID client manifest, enable/start explicitly owned authority/tunnel services, prove authenticated uninitialized authority, hand off controllers through existing activation, and replace Root through its existing atomic idle release protocol. Busy Root defers without killing its accepted native work. An explicit empty `capacityServices` array means this host owns no service.
- `verify`: inspect real selected markers, live controller health pinned to their startup release, configured UID manifest, actual namespace/source access and selected managed launchers. Old controllers, unmanaged launchers or unavailable owner coverage do not become success.
- `census`: read only execution/custody metadata as each actual owning UID inside the source's mount namespace. Plans are passed on stdin, avoiding private `/tmp` and root-only-file failures. Sources are grouped by namespace. Every owner appears, including owners with no execution.
- `doctors`: read-only initialized-authority proof, then mandatory guarded browser/model doctors under the fleet identity.
- `restore`: verify again before opening guarded router ingress.

Host plans require `version`, `host`, `barrierId`, `releaseCommit`, `checkout`, `hostFile`, `preparedClientConfig`, `activeClientConfig`, `orchestrator`, `stateDir`, `capacityServices`, and `owners`. Each owner has `ownerId`, `controllers: [{unit, healthUrl, kind}]` and `sources: [{kind, path, namespaceUnit}]`. Controller kinds are `remote | daemon | root`; health URLs are explicit loopback `/v1/health`. Source kinds are `threadDatabase | threadDatabaseDirectory`. A directory recursively discovers exact `threads.sqlite3` filenames, including Root's configured private `sessionsDir/<request-uuid>/threads.sqlite3`. Directory access and database reads run inside its owning namespace; missing/unreadable paths and symbolic links fail closed. `namespaceUnit: null` means the public host namespace, still read as the configured owning UID. Different sources of the same owner may have different namespaces. Census receipts contain identities and custody metadata, never native trace or request content.

A locked, inactive person's source can instead be `inactivePersonal`, with its source path, Remote namespace unit, configured `dataDir` and actual `uid`. The adapter checks that unit is inactive and scans for retained native processes under both normal and shortened runner socket paths. It records this lifecycle evidence; it does not declare an inaccessible encrypted database empty. Every Remote controller requires either its actual personal database source or this explicit lifecycle descriptor. Unexpected retained native custody keeps that source unavailable.

`deploy/direct-agent-ingress` supplies `{cli:"managed",sdk:"managed",root:"idle-managed",evidence:{releaseCommit}}` after checking the selected managed runtime, account launcher realpaths and Root's release identity. Every stack-owned agent execution has ThreadService custody. Managed retained runners remain in the census and are attached by their new controllers without replaying accepted prompts. Tool-free inference has no executing agent and contributes no custody row.

## Durable phase contract

`deploy/capacity-bootstrap advance PLAN` advances one phase under `flock`: `unprepared → gated → censused → initialized → proved → opened`. Every configured host/owner must be covered. A census above100 leaves the authority uninitialized and retains all entries for recapture after natural settlement. The initializer stores intent before mutation and reconciles seeded identities after a lost acknowledgement instead of reseeding. Failures do not auto-reopen ungated old producers.

Normal `deploy/host` checks `deploy/capacity-ready.mjs` as the fleet Unix owner under a ten-second deadline before starting doctors or activation. The deadline launches Bash and loads `deploy/lib` there; `pi_stack_run_as` is a shell function, not an executable. An uninitialized authority exits75 without starting those phases. The first-cutover job runs before ordinary publication.

Synthetic source proof: `node --test deploy/capacity-bootstrap.test.mjs deploy/capacity-host.test.mjs`. These tests exercise phase ordering, overcapacity refusal, missing/locked owners, old Root/controller refusal, actual-UID namespace/stdin execution, source-candidate identity and seed acknowledgement recovery. Live admission/adoption and both-host final publication are subsequent operational results.
