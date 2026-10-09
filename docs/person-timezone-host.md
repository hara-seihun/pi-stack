# Person timezone host transport

[`deployment.md`](deployment.md) owns release ordering. Canonical personal settings remain in the owning Remote DATA directory. A narrow projection is `/var/lib/pi-timezones/USER/timezone.json`; its only data is the authoritative timezone and provenance, or an explicit updating fence. No private directory is mounted into fleet/terminal/Root merely to obtain a timezone.

`apps/remote/server/pi-timezone-provision` requires root and explicit Unix users. It creates `pi-timezones-readers`, root-owned0755 base and own-UID/shared-group02750 directories. It never writes a timezone value. `--configure` declares the exact path in person registry and fleet unit environment, preserving existing configuration ownership. Existing memory auth receives exact per-supervisor `timezoneFile` paths and its runtime config declares the fixed reader group. Future person add and `deploy/account` use the same provisioner. Service-free deployment rehearsals make no host configuration changes.

Remote startup migrates its own canonical calendar observation and reconciles the projection before model admission. Source settings writes fence updates; projection files are explicitly0640 even under the supervisor's0077 umask. Missing/updating/malformed declared files are errors, not a guessed timezone. A ready null timezone means this owner genuinely has no configured or observed setting.

`deploy/host` activates Remote first, verifies strict own-UID/group/mode/schema readiness for every unlocked owner with `deploy/timezone-ready`, then activates fleet daemons. Locked owners with no projection remain explicitly unavailable until their owner unlocks; accepted input must remain pending rather than be consumed by a failed delivery. Fleet sessions pass their trusted unit path. The terminal entrypoint resolves the configured projection directory from its actual Unix account and discards another inherited projection path.

Only the memory runtime receives the `pi-timezones-readers` supplementary group, after its fixed privileged launcher calls `initgroups`. Root and journal do not. Memory returns narrow timezone metadata for its authenticated asking person; Root clears inherited settings/projection paths and receives that metadata, not filesystem access. The owning host must activate the updated memory broker before the updated Root consumer.

Focused installation invariants: `node --test scripts/timezone-host.test.mjs`; `python3 scripts/timezone-provision.test.py`. Neither contacts a model or touches production settings.
