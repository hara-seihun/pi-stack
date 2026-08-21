# bash-timeout-guard

Every `bash` tool call on this machine must carry an explicit timeout of at
most **1800 seconds (30 minutes)**. This extension enforces that for every pi
session — interactive, Pi Remote, prompt-eval, and every orchestrator-hosted
fleet session — and states the rule in the system prompt so agents comply on
the first call instead of learning it from a block.

An unbounded `bash` call is the one tool call that can hold a session (and, in
the fleet, a claimed run and its lease) for as long as the command decides to
live. Agents reliably write `timeout`-less calls for builds, `nix` rebuilds,
census jobs, and `ssh` sessions that then hang on a prompt no one can answer.
Nothing else in pi bounds them: the bash tool's own default is *no* timeout.

## Behaviour

- `tool_call` on `bash` returns `{ block: true, reason }` when `timeout` is
  absent, non-numeric, non-positive, or above 1800. The block is not
  terminating: the model sees the reason and reissues the call correctly.
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
artifact). Both lists are written by [`tools/pi-runtime/deploy`](../../deploy);
sessions read settings at launch, so a deploy reaches new fleet sessions
without a runner drain.

Tests: `node --test guard.test.mjs`, also run by `npm test` in
[`tools/pi-runtime`](../../package.json).

Verification after a change:

```bash
pi --no-session -p "Use the bash tool to run: echo hello. Set the bash timeout parameter to 7200 seconds exactly, and if a call is blocked, report the block reason verbatim and stop."
```
