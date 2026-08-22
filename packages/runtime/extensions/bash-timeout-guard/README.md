# bash-timeout-guard

Every `bash` tool call on this machine must carry an explicit timeout. The cap
is **300 seconds (5 minutes)** for orchestrator-hosted fleet sessions and **1800
seconds (30 minutes)** for interactive Pi, Pi Remote, and prompt-eval sessions.
Fleet sessions must additionally run their work **in the foreground**. The
extension states the applicable rule in the system prompt so agents comply on
the first call instead of learning it from a block.

An unbounded `bash` call is the one tool call that can hold a session (and, in
the fleet, a claimed run and its lease) for as long as the command decides to
live. Agents reliably write `timeout`-less calls for builds, `nix` rebuilds,
census jobs, and `ssh` sessions that then hang on a prompt no one can answer.
Nothing else in pi bounds them: the bash tool's own default is *no* timeout.

Detached work is worse than a long call, which is why the fleet may not start
any. It reparents off the runner worker, so the cap no longer applies to it and
the session that wanted the answer ends without it; the result is written to a
file in `/tmp` that nobody reads. On 2026-08-22 two such jobs — a 32-thread
census and a 12-hour Z3 run, both launched under the previous rule, which told
agents to detach — held the machine at 100% CPU for hours after their sessions
were gone. Operator directive, same day: fleet sessions run in the foreground.

## Behaviour

- `tool_call` on `bash` returns `{ block: true, reason }` when `timeout` is
  absent, non-numeric, non-positive, or above the session's cap. The block is
  not terminating. The model sees the reason and reissues the call correctly.
- In fleet sessions it also blocks a command that detaches: `nohup`, `setsid`,
  `disown`, `systemd-run`, `daemonize`, `tmux`, `screen`, `crontab`, `at`,
  `batch`, or a background `&`. `findDetachment` scans with quotes removed, so
  `sed 's/x/&/'` and `2>&1` are not operators, and it recurses into a quoted
  `sh -c '…'` payload, which is where the `&` otherwise hides.
- A command that also contains `wait` keeps its `&`: `for i in …; do ./shard
  $i & done; wait` is parallelism inside the call, which is the answer to a
  job that does not fit rather than a way around the cap. The call still
  blocks and the sweep still collects anything left behind.
- That block is the one message in this extension written to be read rather
  than obeyed: it says why the machine cannot carry the job, offers shrinking
  the instance, taking a smaller bite, and checkpointing, and names reporting
  the computation as too large in `task_complete` as a good outcome. An agent
  that hits it is doing the reasonable thing under an old assumption, not
  misbehaving. Keep it that way if you edit it.
- `PI_ORCHESTRATOR_ASSIGNED=1`, set by the fleet runner before it loads Pi,
  selects the fleet policy. Every other process gets the interactive one, which
  still recommends detaching: a Pi Remote session ends when Hara stops typing
  and its background job is exactly what should outlive it.
- `before_agent_start` appends the rule to the system prompt once per turn
  (skipped when the prompt already carries it, so chained handlers and
  resumed prompts cannot duplicate it).
- Enforcement lives on the event, not on a tool override, so it still applies
  when another extension replaces the `bash` tool (for example an SSH backend).
- `!` shell commands typed by the operator (`user_bash`) are untouched.

A command string is a hint, not a boundary — a determined agent can hide a
detach from any scanner. `pi-fleet-command-sweep` in
[`/etc/nixos/configuration.nix`](../../../../../etc/nixos/configuration.nix) is
the enforcement: every minute it kills any orchestrator-owned process carrying
`PI_SESSION_ID` that has outlived the cap, whatever its parent is now.

## Operations

Loaded as a pi package from `~/.pi/agent/settings.json` (interactive) and
`/home/orchestrator/.pi/agent/settings.json` (fleet, from the `/srv/pi`
artifact). Both lists are written by [`tools/pi-runtime/deploy`](../../deploy).
The fleet runner caches extension code in its worker process. Run
`pi-orchestrator drain-runners` after deploying a code change. The successor
worker uses the new cap while active agents finish on the draining worker.

Tests: `node --test guard.test.mjs`, also run by `npm test` in
[`tools/pi-runtime`](../../package.json).

Verification after a change:

```bash
pi --no-session -p "Use the bash tool to run: echo hello. Set the bash timeout parameter to 7200 seconds exactly, and if a call is blocked, report the block reason verbatim and stop."
sudo -n -u orchestrator env PI_ORCHESTRATOR_ASSIGNED=1 node --input-type=module -e 'import("/srv/pi/extensions/bash-timeout-guard/index.mjs").then(({ checkBashCommand, timeoutPolicy }) => console.log(checkBashCommand("nohup ./census &", timeoutPolicy())))'
```
