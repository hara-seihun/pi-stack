# Deployment

One public commit goes to GMKtec and Converge. A host may build only what it runs, but it may not combine components from different commits.

## Source and state

Both hosts check out this repository at `/home/kenan/projects/pi-stack`. Build output goes under `/srv/pi`; services never execute a mutable checkout they cannot read.

Host repositories own:

- systemd units and service users;
- endpoint URLs and ports;
- Pi Remote profiles and workspaces;
- Tailscale enrollment;
- account configuration and credentials;
- mutable ledgers, sessions, uploads, and encrypted folders.

This repository owns build commands, package order, API contracts, and component tests. `deploy/runtime`, `deploy/orchestrator`, `deploy/remote`, and `deploy/tools` publish immutable artifacts and record the source commit beside them.

## Build checks

```bash
cd /home/kenan/projects/pi-stack
npm ci --ignore-scripts
npm run check
cd apps/remote/android
./gradlew test
```

The Android build reads these uncommitted properties:

```properties
piRemoteLocalUrl=https://gmktec.example-tailnet.ts.net
piRemoteConvergeUrl=https://converge-kenan.example-tailnet.ts.net
```

The real tailnet suffix belongs in machine-local configuration, not documentation or source.

## GMKtec

The NixOS repository owns the deployment command and service definitions. It publishes:

- Pi and runtime releases under `~/.local/share/pi-runtime`;
- Orchestrator under `/srv/pi/pi-orchestrator`;
- fleet-readable extensions, skills, providers, and shell tools under `/srv/pi`;
- Pi Remote from `apps/remote` behind its identity router.

Local Pi Remote reports environment ID `local`, requires unlock, and offers only Personal and Home after the Converge cutover.

Never restart the orchestrator runner to update it. Drain it so existing agent processes finish on their current generation.

## Converge

Converge OpenTofu owns one `pi_stack_commit`. Its startup configuration clones that commit, installs the root lockfile, builds Orchestrator, reconciles Pi settings from `config/package-sets.json`, and starts Pi Remote.

Converge Pi Remote reports environment ID `converge`. It has one profile rooted at `/home/kenan/converge` and executes Pi directly on that machine.

Pi Remote listens on loopback. Tailscale Serve publishes it to the tailnet. No GCP firewall rule exposes the application port.

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
- Tailscale reaches both endpoints and GCP exposes no Pi Remote port;
- Android can switch repeatedly without crossing threads, keys, voice, downloads, or notifications;
- a migrated Work thread resumes on Converge;
- both machine handbooks point here.
