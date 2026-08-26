# thread-lab (`tlab`)

Temporary, scriptable model threads for prompt experiments. Built for A/B tests
on fleet prompting (the first: does `attack.md` in the user message move a
model's self-assessed odds on an open problem), useful any time you want to ask
"what does model X say when I send exactly Y, and then follow up?"

Each thread is a pi session driven one `pi -p` turn at a time. Turns run
detached in a tmux session (`tlab-<name>`), so the caller launches, polls with
short bounded commands, and reads results — no blocking on the model.

```bash
tlab new e1 --model openai-codex/gpt-5.6-sol --thinking xhigh
tlab send e1 -f prompt.md         # or: tlab send e1 "inline text"
tlab status                       # all threads; `tlab status e1` for one
tlab wait e1 120                  # poll until the turn ends
tlab out e1                       # assistant output (latest turn)
tlab trace e1                     # thinking blocks (latest turn)
tlab transcript e1                # whole thread: prompts, thinking, outputs
tlab rm e1
```

## What a thread sees

By default: no skills, no AGENTS.md/CLAUDE.md context files, no tools, a fresh
cwd. The only context is the pi default system prompt plus what you send —
that is the point; host context like the stale-difficulty-priors section of
AGENTS.md would contaminate a control arm. `--tools` at `new` re-enables pi's
builtin tools; `--append-system FILE` pins a file into the system prompt
(for doctrine-placement experiments). Extensions stay enabled because the
orchestrator's routing extension is what serves shared codex/cursor account
credentials.

## State

`~/data/thread-lab/<name>/` (override root with `TLAB_ROOT`):

- `config.json` — model, thinking level, tools flag, system-prompt appends
- `session.jsonl` — the pi session (thinking blocks live here; turn N is the
  Nth assistant message)
- `turns/NNN.prompt.md|out|err|exit|run.sh` — per-turn artifacts

Experiment prompt files and writeups live under
`~/data/thread-lab/_experiments/<date-name>/`. Threads are disposable;
`tlab rm` deletes without ceremony. Nothing here is canonical state — results
worth keeping get written into an experiment summary or the relevant project.

Codex models return reasoning summaries, not full traces; `tlab trace` shows
whatever the provider stored.

Installed as a symlink: `~/.local/bin/tlab` points to `~/tools/thread-lab/main`.
