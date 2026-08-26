# Deployment

One public commit goes to GMKtec and Converge. A host may build only what it runs, but it may not combine components from different commits.

## Source and state

Both hosts check out this repository at `/home/kenan/projects/pi-stack`. Build output goes under `/srv/pi`; services never execute a mutable checkout they cannot read.

Host repositories own:

- systemd units and service users;
- endpoint URLs and ports;
- Pi Remote profiles and workspaces;
- endpoint network access and SSH forwarding identities;
- account configuration and credentials;
- mutable ledgers, sessions, uploads, and encrypted folders.

This repository owns build commands, package and skill roles, API contracts, and component tests. `deploy/runtime`, `deploy/orchestrator`, `deploy/remote`, and `deploy/tools` publish immutable artifacts and record the source commit beside them. `deploy/settings ROLE` reconciles Pi's ordered package list, and `deploy/skills ROLE` publishes and links the role's first-party skills.

## Build checks

```bash
cd /home/kenan/projects/pi-stack
npm ci --ignore-scripts
npm run check
cd apps/remote/android
./gradlew test
```

The Android build reads endpoint access from uncommitted properties. A direct endpoint needs only its URL. An SSH endpoint uses a loopback URL created by the app and requires its forwarding identity:

```properties
piRemoteLocalUrl=https://gmktec.example-tailnet.ts.net
piRemoteConvergeAuth=ssh
piRemoteConvergeSshHost=converge.example.net
piRemoteConvergeSshPort=22
piRemoteConvergeSshUser=pi-remote-android
piRemoteConvergeSshPrivateKeyFile=/owner-only/path/to/android-converge-key
piRemoteConvergeSshHostKey=ecdsa-sha2-nistp256 <base64-encoded host key>
piRemoteConvergeSshLocalPort=8789
piRemoteConvergeSshRemoteHost=127.0.0.1
piRemoteConvergeSshRemotePort=8788
```

Hostnames and credentials belong in machine-local configuration, not documentation or source. The SSH account must allow local forwarding only to the configured Pi Remote port.

## GMKtec

The NixOS repository owns the deployment command and service definitions. It publishes:

- Pi and runtime releases under `~/.local/share/pi-runtime`;
- Orchestrator under `/srv/pi/pi-orchestrator`;
- fleet-readable extensions, skills, providers, and shell tools under `/srv/pi`;
- Pi Remote from `apps/remote` behind its identity router.

Local Pi Remote reports environment ID `local`, requires unlock, and offers only Personal and Home after the Converge cutover.

Never restart the orchestrator runner to update it. Drain it so existing agent processes finish on their current generation.

## Converge

Converge OpenTofu owns one `pi_stack_commit`. Its startup configuration clones that commit and invokes the repository deployment commands in this order:

```bash
deploy/runtime
deploy/orchestrator
deploy/remote
deploy/tools converge
deploy/skills converge-user
deploy/settings converge-user
```

The last two commands derive the deployed skill and package lists from the checked manifests. Pi Remote remains last without an OpenTofu copy of that order.

Converge Pi Remote reports environment ID `converge`. It has one profile rooted at `/home/kenan/converge` and executes Pi directly on that machine.

Pi Remote listens on loopback. Android opens a pinned SSH connection and forwards its app-local port to that listener. A dedicated SSH account accepts the app key with forwarding restricted to `127.0.0.1:8788`; it cannot open a shell. No GCP firewall rule exposes the application port.

## Work-thread cutover

Do not start Converge Pi Remote for ordinary use until the existing GMKtec work sessions have moved.

1. Disable new Work starts on GMKtec.
2. Settle active Work runs and take a verified supervisor database backup.
3. Stop the Local supervisor and export the Converge execution target:

   ```bash
   bun /srv/pi/pi-remote/server/session-migration.ts export \
     --db /home/kenan/data/pi-remote/supervisor.sqlite3 \
     --data /home/kenan/data/pi-remote \
     --target converge \
     --bundle /home/kenan/data/pi-remote/converge-cutover
   ```

4. Copy the bundle to Converge over the existing SSH path.
5. Keep Converge Pi Remote stopped and import before it creates a thread:

   ```bash
   bun /srv/pi/pi-remote/server/session-migration.ts import \
     --db /home/kenan/.local/share/pi-remote/supervisor.sqlite3 \
     --data /home/kenan/.local/share/pi-remote \
     --bundle /home/kenan/converge-cutover
   ```

6. Start Converge Pi Remote. Verify list, transcript, continuation, archive, download, and completion behavior.
7. Restore the backup into a temporary path and compare its session count and hashes. Then remove the source rows with `session-migration.ts remove-source` and delete their copied files.
8. Remove the SSH work bridge and remote orchestrator reader from Local configuration and source.

## Release verification

A release is complete when:

- `git rev-parse HEAD` matches on both hosts;
- root checks and Android tests pass;
- each service reports the intended environment ID;
- Pi settings match the role in `config/package-sets.json`;
- Pi Remote is last for roles that load it;
- Tailscale reaches Local, the restricted SSH key reaches Converge, and GCP exposes no Pi Remote port;
- Android can switch repeatedly without crossing threads, keys, voice, downloads, or notifications;
- a migrated Work thread resumes on Converge;
- both machine handbooks point here.
