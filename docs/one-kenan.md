# One Kenan per machine

One machine's Kenan serves every person from a shared execution identity, with person-tagged memory and discretion rather than separate agents borrowing each other's permissions. Authentication remains person-specific. A different machine's Kenan is a different self; working over SSH does not copy memory to that machine.

## Activation boundary

The host switch is exactly `oneKenan: true` in the host JSON file (`PI_STACK_HOST_FILE` / `PI_STACK_HOST_CONFIG`, normally `/etc/pi-stack/host.json`). Missing, false, or any other value means off. Other component configuration is separate from this boolean.

This build is published **off**. Publication does not authorize cutover. Until the person authorizes cutover, the existing router, per-person supervisors, authentication, ports and stores remain the operating path. The additive units must not be started by ordinary flag-off deployment.

Keep SSH available throughout cutover. Do not use the live stack as staging. Folder keys, credentials, plaintext private data and person registries are host-owned and never committed.

## Fixture staging

From a checkout with dependencies and the orchestrator build prepared:

```sh
source deploy/lib
pi_stack_prepare_dependencies "$PWD"
node scripts/build-workspace.mjs orchestrator
bun scripts/one-kenan-staging.ts --root /tmp/pi-one-kenan-staging --port 19880
```

The foreground harness owns a real router and real Remote supervisors on loopback 19880–19882. Its Alice/Bob registry, homes, settings, folder-key fixtures, service-manager shim, databases and logs all live under the selected fixture root. It inherits no live Pi URLs, account settings or credentials. The shim refuses operations outside fixture services. The harness always stops its own children before returning; it does not detach a test stack or alter the host service manager.

`proof.json` records checks; `logs/` holds process output. Flag-off checks cover independent login, wrong-key refusal, session/person mismatch, separate thread visibility and thread durability across process replacement. No provider call is made by this baseline.

## Custody after reboot

Without a hardware-bound boot secret, custody starts sealed. The first successful login by **any enrolled person** unlocks the custody master and all known folders. Each person continues to authenticate with their own key; an already-open folder is not proof that a new caller supplied the right key. A previously unknown key can enter custody only after it successfully opens that person's folder.

The custody master is wrapped independently by each enrolled person's key. Reboot testing must discard volatile custody state and prove both that a wrong key fails and that a nonadministrator's correct key recovers every known folder. A process restart alone is not a host reboot or a FUSE/mount-namespace proof.

## Acceptance and rollback

The integrated staging proof must include:

- an outbound action from Alice discoverable in Bob's conversation;
- private-memory handling plus the disclosure record;
- no confidential thought/tool bodies leaving an ordinary person's API, including context, item, image and stream paths;
- one room visible to both authenticated participants, with actual speaker identity preserved;
- first-login custody recovery after losing volatile state;
- unchanged flag-off tests, and rollback retaining thread history and folder contents.

The cutover and rollback entrypoint is `deploy/one-kenan`; its exact commands and integrated proof are completed with the identity/custody slice before publication. Do not substitute a manual flag edit: writer handoff, mount namespace, side-unit readiness, ownership and rollback state are part of the operation.
