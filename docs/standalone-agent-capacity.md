# Agents outside ThreadService

All stack-owned executions use the same durable global agent authority as ThreadService. Missing authority configuration or a refused admission prevents execution. This is mandatory application code, not an optional Pi extension.

## Covered entrypoints

| Owner | Admission lifetime | Durable record |
| --- | --- | --- |
| `packages/kenan-root/src/root-runtime.ts` | Each privileged request, before native resources/session creation through awaited native abort + idle + disposal | Configured `sessionsDir/<rootSessionId>/capacity.json` |
| `tools/read-condensed-session/runtime.mjs` | Each direct summary, including bootstrap and provider aliases, until the awaited completion settles | One-shot execution root below |
| `packages/runtime/browser-doctor.mjs` | Native setup, direct browser tool execution and shutdown | One-shot execution root below |
| `packages/runtime/model-selection-doctor.mjs` | Sequential SDK sessions and bundled CLI probes; never parallel native executions within its one custody | One-shot execution root below |
| `packages/runtime/extensions/codex-compaction/smoke.mjs` | Compaction and continuation through native settlement | One-shot execution root below |
| `packages/orchestrator/scripts/image-generation-probe.mjs` | Native setup and awaited image tool through shutdown | One-shot execution root below |
| `deploy/publication` repair runner | Mandatory `stack-agent.mjs` wrapper, including child/tools, until child close and disappearance of its process group | Repair receipt's directory, `capacity.json` |
| Account `~/.local/bin/pi` | Mandatory `stack-pi.mjs` launcher for all session-bearing CLI invocations | One-shot execution root below |

`deploy/runtime` publishes a closed Node-only guard/client beside the doctors and launchers and reconciles every account's `pi` link. Exact one-argument version/help invocations do not construct an executing session and need no slot. When publication wraps the exact installed stack-owned Pi launcher, it invokes that launcher's native CLI under the wrapper's existing custody. It does not trust inherited managed-agent flags. New direct CLI executions launched from an agent's bash tool still acquire their own slots.

ThreadService-native managed SDK executions are not additionally wrapped here. Their owner supplies the global admission. Provider requests, account routing, native compaction and tools belonging to that same session remain within its admission.

## Configuration and custody

The owning client selects the actual UID's entry in `/etc/pi-stack/agent-capacity-client.json`, or an absolute `PI_AGENT_CAPACITY_CONFIG`. An explicit environment tuple uses `PI_AGENT_CAPACITY_URL`, `PI_AGENT_CAPACITY_OWNER`, and absolute `PI_AGENT_CAPACITY_TOKEN_FILE`; a partial tuple is an error. No authority or identity is invented when configuration is missing.

One-shot records live at `~/.local/state/pi-stack-agent-executions/<UUID>/capacity.json`, or under absolute `PI_STACK_AGENT_EXECUTIONS_DIR`. The owning type is `StandaloneCapacityRecord` in `packages/orchestrator/src/standalone-agent.ts`: version, authority owner, stable agent/execution identities, custodial PID and Linux process start identity, and `acquiring | held | settled | released`; non-acquiring states include the lease ID. Records are fsynced before acquiring, before execution, before release, and after the release acknowledgement.

A per-record exclusive lock prevents duplicate native execution under one lease. `held` or uncertain state is not replayed. A native cancellation must successfully await `abort()` and observe `isIdle` with no streaming, compaction or retry before release. Sending a signal is not settlement: the CLI wrapper waits for child close and proves its process group absent. Failed cancellation or surviving descendants retain custody. The recorded PID is the custodial wrapper, not an exhaustive list of descendants: **a dead wrapper PID alone never authorizes release**.

Root capacity denial is a typed pre-execution result. Its request remains durably queued with an explicit global-capacity reason and retry time, and the root reconciler resumes the same audience-checked admission when capacity is available. The encrypted store retains request text, not the credential. Local root concurrency waits are queued too. The request becomes executing only after global admission; an interrupted executing request is never replayed.

`settled` is a durable positive proof; recovery may replay release without executing another agent. The authority tombstones released execution IDs. A later distinct attempt uses a new durable execution ID, not the released ID. Unacknowledged acquisition preserves its identity for a safe idempotent retry. Initial all-owner census must include these records as well as ThreadService records before opening fresh admission; release rollout owns that cutover.

## First-cutover direct ingress proof

`deploy/direct-agent-ingress EXPECTED_COMMIT [HOST_FILE]` is read-only. It checks the selected guarded runtime and each configured account's exact `pi` realpath. An active root must report the target commit and protocol with a known MainPID; the owning `one-kenan-activate activate` hook separately performs the authenticated idle-release/replacement protocol before this check. Busy old root work is pending, never killed.

The helper requires absolute `PI_CAPACITY_DIRECT_CUSTODY_RECEIPT`: `{version:1,processes:[{pid,processStart,ownerId,agentId,executionId}]}`. It scans actual process identities for the source-owned CLI, doctors, condenser, SDK probes/acceptance and root entrypoints, including inline SDK factory calls. Each still-live direct execution must match retained process identity or a retained custodial ancestor. Unmatched processes or unreadable evidence hold cutover; matching a PID without its Linux start identity is insufficient. The bootstrap engine must also match those retained agent/execution identities to the all-owner census. Command lines are classified but never included in output.

Success supplies the `directIngress` portion `{cli:"gated",sdk:"gated",root:"idle-gated",oldProcesses:[],evidence:{...}}` with retained-process evidence. It does not replace the bootstrap owner's controller, owner coverage or census receipts.

## Exact exclusions

The upstream CLI is still accessible explicitly at `/srv/pi/runtime/node_modules/.bin/pi` and `node /srv/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`, and independent callers can use upstream SDK factories. Those are raw human/outside-stack interfaces, not stack launchers. Stack source does not use these routes for a new unguarded execution; the model doctor invokes its bundled probe as a mutually exclusive sub-operation under its own mandatory custody. Existing source tests that create mock/loopback SDK sessions remain isolated tests, not production agent launchers.

The authority cannot infer custody for raw human agents already running before cutover. The rollout census must explicitly identify them as outside scope or import their actual custody, never silently reset them away.

## Focused source proofs

- `packages/orchestrator/tests/standalone-agent.test.ts`: cap 101, duplicate execution, failed native cancellation/activity, positive settlement, durable lost-release recovery, and unset configuration.
- `packages/runtime/stack-agent.test.mjs`: real subprocess refusal at 101, release only after child exit, cancellation refusal retaining custody, and inherited managed-marker non-bypass.
- `scripts/publication-progress.test.mjs`: publication repair uses its explicit durable wrapper path and still preserves its existing single-launch/result lifecycle.
- `scripts/direct-agent-processes.test.mjs`: exact PID/start custody and descendant matching, old-root detection, and missing evidence failing closed.

Source changes alone do not perform the all-owner census, configure host credentials, restart services or activate these launchers. The combined publication owner performs rollout.
