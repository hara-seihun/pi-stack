# bash-timeout-guard

Every `bash` tool call on this machine must carry an explicit timeout. The cap
is **300 seconds (5 minutes)** for orchestrator-hosted fleet sessions and **1800
seconds (30 minutes)** for interactive Pi, Pi Remote, and prompt-eval sessions.
The extension states the applicable rule in the system prompt so agents comply
on the first call instead of learning it from a block.

An unbounded `bash` call is the one tool call that can hold a session (and, in
the fleet, a claimed run and its lease) for as long as the command decides to
live. Agents reliably write `timeout`-less calls for builds, `nix` rebuilds,
census jobs, and `ssh` sessions that then hang on a prompt no one can answer.
Nothing else in pi bounds them: the bash tool's own default is *no* timeout.

## Behaviour

- `tool_call` on `bash` returns `{ block: true, reason }` when `timeout` is
  absent, non-numeric, non-positive, or above the session's cap. The block is
  not terminating. The model sees the reason and reissues the call correctly.
- `PI_ORCHESTRATOR_ASSIGNED=1`, set by the fleet runner before it loads Pi,
  selects the 300-second cap. Every other process gets the 1800-second cap.
- The fleet rule also says five minutes is a ceiling and a command should aim
  to finish inside a minute. A capped call is still a capped wait, and a fleet
  session that spends it on one census is a claimed run doing nothing.
  Operator directive, 2026-08-21.
- `before_agent_start` appends the rule to the system prompt once per turn
  (skipped when the prompt already carries it, so chained handlers and
  resumed prompts cannot duplicate it).
- Enforcement lives on the event, not on a tool override, so it still applies
  when another extension replaces the `bash` tool (for example an SSH backend).
- `!` shell commands typed by the operator (`user_bash`) are untouched.

Work that genuinely runs longer belongs in the background: start it detached
(`systemd-run --user --unit=<name>`, or `nohup … > log 2>&1 &`) and poll its
log or status with short bounded calls. There is no escape hatch, because
every long job has that form.

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
sudo -n -u orchestrator env PI_ORCHESTRATOR_ASSIGNED=1 node --input-type=module -e 'import("/srv/pi/extensions/bash-timeout-guard/index.mjs").then(({ timeoutPolicy }) => console.log(timeoutPolicy()))'
```
