# Deployment

One reviewed commit goes to GMKtec and Converge. A host may build only what it runs, but it may not combine components from different commits.

## Source and state

Both hosts check out this public repository at `/home/kenan/projects/pi-stack` through an authenticated HTTPS remote. A host that cannot run `git fetch --dry-run origin` cannot deploy. Build output goes under `/srv/pi`; services never execute a mutable checkout they cannot read.

Host repositories own:

- systemd units and service users;
- endpoint URLs and ports;
- Pi Remote profiles and workspaces;
- endpoint network access and SSH forwarding identities;
- account configuration and credentials;
- authoritative task manifests and their prompt/probe files;
- mutable ledgers, sessions, uploads, and encrypted folders.

A host points Orchestrator's operator config at its version-1 task manifest. Controller startup reconciles the complete set atomically, so replacing a host does not depend on remembered `task set` commands and a removed lane cannot linger in SQLite. Pause controls remain mutable ledger state and survive reconciliation.

This repository owns build commands, package and skill roles, API contracts, and component tests. CI runs the complete check before publication. Its dedicated self-hosted runner retains the checkout between jobs, and `pi_stack_prepare_dependencies` proves the installed lock before reuse. A runner restart loses that cache and performs a clean install. Deployment builds the two compiled packages and does not repeat tests that already passed on the immutable commit.

`deploy/runtime`, `deploy/orchestrator`, `deploy/remote`, `deploy/tools`, and `deploy/skills` publish commit-addressed releases. Runtime owns one lockfile-addressed production dependency tree under `/srv/pi/dependencies`. Runtime, Orchestrator, and tools link that tree instead of copying hundreds of megabytes. Component destinations switch to complete releases with an atomic filesystem exchange. `/srv/pi/.pi-stack-releases` retains prior component generations for processes that loaded them before the exchange.

Every deployment command locks its checkout before reading source. A dependency receipt avoids reinstalling an unchanged development tree and invalidates itself if npm changes the installed lock. `deploy/settings ROLE` reconciles Pi's ordered package list. The host keeps the source lock until every artifact carries the same commit. The outer deployment process has a 50-second deadline, including lock wait and all child deployments. An isolated first publication measured 6.33 seconds with a prepared development tree. A clean npm install measured 3.12 seconds. An unchanged host redeploy measured 1.06 seconds.

## Build checks

```bash
cd /home/kenan/projects/pi-stack
npm ci --ignore-scripts
npm run check
npm run android:test --workspace=kenan
```

Kenan reads endpoint access from `apps/kenan/android/local.properties`. A direct endpoint needs only its URL. An SSH endpoint uses a loopback URL created by the app and requires its forwarding identity:

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

`deploy/remote` publishes without ending active work. Host deployment calls `apps/remote/activate` after every changed Pi Remote release. You can run it directly to repeat activation. It switches the supervisor to the selected release immediately. The systemd service keeps a small launcher as its main process. Each Pi RPC child runs behind a runtime host in the same encrypted mount namespace and service cgroup. During activation, the old supervisor writes its runtime state, disconnects from those hosts, and exits. The launcher starts the selected supervisor, which reconnects to every host before serving requests. Active turns keep their process, stream, and RPC state. They are neither aborted nor replayed. After an adopted runtime settles, the supervisor replaces it before its next use so provider and extension changes take effect. A full service stop still kills the whole cgroup and unmounts the encrypted folder.

## GMKtec

The NixOS repository owns the deployment command and service definitions. It publishes:

- Pi and runtime releases under `~/.local/share/pi-runtime`;
- Orchestrator under `/srv/pi/pi-orchestrator`;
- fleet-readable extensions, skills, providers, and shell tools under `/srv/pi`;
- Pi Remote from `apps/remote` behind its identity router.

Local Pi Remote reports environment ID `local`, requires unlock, and offers only Personal and Home after the Converge cutover.

An ordinary Orchestrator update does not restart the runner service. The host deployment bumps the runner generation, and the supervisor starts a worker from the new release while existing workers finish on their current generation. The candidate Orchestrator parses the host's current task manifest before publication. An incompatible manifest fails the deployment while the selected release remains unchanged. Changes to `host/supervisor.ts` or `ledger/ledger.ts` stop the controller and runner before publishing the new artifacts. Deployment then starts the runner and controller on the new build. The supervisor cannot reload its own module, and storage migrations cannot race workers or a controller using the previous schema. Runner startup requeues every persisted session from the stopped workers, and the new worker reopens them. Every Orchestrator release also restarts the stateless voice broker so it loads the same build.

## Converge

Converge OpenTofu owns one `pi_stack_commit`. Its startup configuration clones that commit and runs the atomic host deployment:

```bash
deploy/host converge
```

The command publishes runtime, Orchestrator, Pi Remote, tools, skills, and settings while holding one source lock. It derives the deployed skill and package lists from the checked manifests. The candidate Orchestrator must parse the current task manifest before its release can be selected. If a live Orchestrator ledger exists and an ordinary release changed, the command bumps the runner generation instead of restarting workers. Supervisor and runner-storage changes stop the controller and runner before publication, reopen persisted sessions on the new build, then start the new controller. The stateless voice broker restarts on every Orchestrator release. If Pi Remote changed, it performs a live supervisor handoff before returning. The whole command must finish within 50 seconds. A timeout is a deployment failure, never permission to raise the limit.

Converge Pi Remote reports environment ID `converge`. It has one profile rooted at `/home/kenan/converge` and executes Pi directly on that machine.

Pi Remote listens on loopback. Kenan opens a pinned SSH connection and forwards its app-local port to that listener. A dedicated SSH account accepts the app key with forwarding restricted to `127.0.0.1:8788`; it cannot open a shell. No GCP firewall rule exposes the application port.

## Environment ownership

Work threads and autonomous work agents belong to Converge. Personal and Home threads belong to Local. Each Pi Remote reads only its host's orchestrator through `OrchestratorClient`; environment aggregation happens in Android, not through an SSH work bridge or a copied ledger.

## Release verification

A release is complete when:

- `git rev-parse HEAD` matches on both hosts;
- root checks and Android tests pass;
- each service reports the intended environment ID;
- Pi settings match the role in `config/package-sets.json`;
- Pi Remote is last for roles that load it;
- Tailscale reaches Local, the restricted SSH key reaches Converge, and GCP exposes no Pi Remote port;
- Kenan can switch repeatedly without crossing threads, keys, voice, or downloads;
- a migrated Work thread resumes on Converge;
- both machine handbooks point here.
