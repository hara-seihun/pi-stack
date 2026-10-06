# One Kenan per machine

## Architecture

Person threads remain the current per-person threads: the same Unix identity, supervisor, directory and fully visible context, tool results and thinking. Household privilege lives in a separate root Kenan service under the `pi-kenan` account, not in those threads. “Root” names the privileged household agent; its model process is not Unix UID 0.

The [root runtime owner](../packages/kenan-root/README.md) includes durable subject-consent dispatch, fresh resumed judgment and chosen-reply delivery to the original thread. `ask_kenan(request)` sends a message from an authenticated person to a fresh root session. The caller can supply only the request, not root's prompt, model, tools, identity or context. Root uses fixed host-owned instructions, all known folder keys and shared memory. It decides what to answer or do. Only its reply leaves that boundary; its session, tool results and thinking do not. Every reply is logged before delivery with its audience and the people it touched. The host administrator may inspect root through an explicit debugging API; root is never a normal person-owned thread-directory member.

Root is the machine's administrator (Hara, 2026-10-04): `pi-kenan` has full sudo and decides about shared things on its own judgment, with only the host administrator above it. Each person is sovereign over their own things — home, files, threads, settings, services, private memory, what they share — against root and the host administrator alike. Grants that today borrow the administrator's Unix identity for another person (sudo-as-`kenan` wrappers) are legacy; new cross-person capabilities are requests to root, which acts on the person's behalf.

User memory tools directly expose own-person facts and action records relevant to that person. Another person's memory, mixed-subject facts and broader accountability go through root. Raw, sandbox and isolated application sessions acquire neither household memory nor its instructions.

Rooms have a separate unprivileged owner. Every member sees the entire room conversation and work. Room tools are `ask_kenan` and asynchronous questions, not shell/file or arbitrary thread-access tools: one room cannot read another room's files or history. The root request carries the authenticated full room audience, not an audience claimed by the model.

The [action journal](action-journal.md) captures successful and uncertain outbound effects durably into shared memory. Uninstrumented routes such as browser webmail, raw SMTP or raw signal-cli still require Kenan to write the action's memory himself. [Converge reach](converge.md) stays in Hara's own thread over her existing SSH identity; root mode requires no new SSH grant.

## Activation boundary

The host switch is exactly `oneKenan: true` in the host JSON file (`PI_STACK_HOST_FILE` / `PI_STACK_HOST_CONFIG`, normally `/etc/pi-stack/host.json`). Missing, false, or any other value means off. Other component configuration is separate from this boolean.

This build is published **off**. Publication does not authorize cutover. Existing router, person supervisors, authentication, ports, stores and trace behavior remain the operating path. Ordinary flag-off deployment must not enable the additive root, memory, custody, room or journal units.

Keep SSH available throughout cutover. Do not use the live stack as staging. Folder keys, credentials, plaintext private data and person registries are host-owned and never committed. The existing person path remains available on both sides of the switch; disabling the additive mode is not a person-supervisor migration.

## Custody after reboot

Without a hardware-bound boot secret, custody starts sealed. The first successful login by **any enrolled person** unlocks the custody master and all known folders. Each person continues to authenticate with their own key; an already-open folder is not proof that a new caller supplied the right key. A previously unknown key enters custody only after it successfully opens that person's folder.

The custody master is wrapped independently by each enrolled person's key. Reboot testing must discard volatile custody state and prove that a wrong key fails and that a nonadministrator's correct key recovers every known folder. A process restart alone is not a host reboot or a FUSE/mount-namespace proof. Root's private shared-memory store lives inside its custody-owned encrypted mount, never a plaintext fallback.

A fixed privileged launcher joins custody's actual mount namespace and drops to `pi-kenan` before executing root, memory or journal code. It pins systemd credentials in sealed memory descriptors across that join. `JoinsNamespaceOf` is not used as a substitute: it does not share mount namespaces.

## Fixture staging

From the integration checkout:

```sh
source deploy/lib
pi_stack_prepare_dependencies "$PWD"
node scripts/build-workspace.mjs orchestrator
bun scripts/one-kenan-staging.ts --root /tmp/pi-one-kenan-staging --port 19880
```

The foreground harness owns a real router and real Remote supervisors on loopback 19880–19882. Its Alice/Bob registry, homes, settings, folder-key fixtures, service-manager shim, databases and logs live under the selected fixture root. It inherits no live Pi URLs, account settings or credentials. The shim refuses operations outside fixture services. The harness always stops its own children before returning; it does not detach a stack or alter the host service manager.

`proof.json` records checks; `logs/` holds process output. Flag-off checks cover independent login, wrong-key refusal, session/person mismatch, separate thread visibility and thread durability across process replacement. This baseline makes no provider call.

Native acceptance creates fresh fixed SDK root sessions with synthetic Alice/Bob memory, the actual memory service, actual journaled mail sender with mocked SMTP, and the real router/supervisors. Run:

```sh
bun scripts/one-kenan-memory-acceptance.ts --models --model sol
bun scripts/one-kenan-memory-acceptance.ts --models --model opus
bun scripts/one-kenan-rooms-acceptance.ts
bun scripts/one-kenan-consent-acceptance.ts --model sol
bun scripts/one-kenan-consent-acceptance.ts --model opus
bun scripts/one-kenan-closure-acceptance.ts
sudo deploy/one-kenan-namespace-rehearse
sudo deploy/one-kenan-fuse-rehearse
sudo deploy/one-kenan-rehearse
```

Provider credentials remain in their existing owner-held resolver; they are not written into fixture keys, prompts, logs or reports. A separate fixture broker uses an isolated metadata ledger, accounts its synthetic usage normally, and never replaces live broker grants. Only synthetic prompts and tool results enter these turns. Rooms run under an existing unprivileged fixture UID with a copy of public source artifacts; no ACL is added to the private writer checkout. The privileged router uses only fixture paths and a fixture service-manager shim.

The closure proof installs production dependencies outside the checkout and initializes Sol and Opus from the exact deployed root/Orchestrator/memory graph. It makes no model call. FUSE proof uses two fixture UIDs and a private mount namespace; transaction proof separately uses stubbed fixture units and firewall commands.

## Acceptance and rollback

Integrated staging must prove:

- an action from Alice's thread is answerable to Bob through `ask_kenan`;
- root withholds an obviously private item and refuses to acknowledge existence when existence would reveal its content;
- boundary accountability records every root reply, including refusals, and “what have you told people about me” answers from that record;
- Bob asks about Alice's borderline item, Alice receives an actual private asynchronous question identifying Bob and the intended disclosure, Alice agrees, and a fresh root judgment delivers the chosen answer to Bob's original thread after a consent-manager restart;
- Bob cannot list or inspect the root session through context, history, item, image, file, stream, export or collaboration paths;
- all own-person and room work remains fully transparent, and one room works from both member clients;
- first-login custody recovery after losing volatile state, unchanged per-person login, wrong-key refusal, and a runtime that joins before custody mounts seeing the later FUSE mount;
- unchanged flag-off tests and rollback retaining thread history, folder contents and encrypted shared state.

## Exact cutover and rollback

After publication is deployed on the host, provision the root-owned plan described in [deployment](one-kenan-deployment.md). From the selected release checkout on kenan-server:

```sh
cd /home/kenan/.local/state/pi-stack-release/repository
sudo deploy/one-kenan prepare --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy
# Run only after Hara says go:
sudo deploy/one-kenan cutover --authorize-cutover --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy
sudo deploy/one-kenan status --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy
# Exact rollback of that same transaction:
sudo deploy/one-kenan rollback --authorize-cutover --config /etc/pi-stack/one-kenan-plan.json --state /var/lib/pi-kenan-deploy
```

Use the same plan and state directory throughout. These commands never restart or stop the existing router, person supervisors or ordinary broker. Router room, custody and admin-debug admission reconcile the host switch/configuration dynamically; existing person sessions load memory lazily at tool execution. A custody/memory outage returns an unavailable tool result without disabling ordinary work.

Rollback restores original host/config/ACL bytes, stops only additive services, removes only their UID-gate table and broker grants, and retains encrypted memory, room history, ciphertext, credentials and transaction evidence. Failure to stop an additive listener retains its gates for repair, rather than exposing it. Do not substitute a manual flag edit: custody, additive ACL state, service readiness and rollback custody are part of the operation. Preparation and publication do not authorize activation.
