# fleet-errors

What the orchestrator fleet's tool calls are failing at, ranked and classified.

```bash
fleet-errors                          # last 24 hours
fleet-errors --since 2h
fleet-errors --tool bash --since 6h
fleet-errors --show "module missing"  # the calls behind a category
fleet-errors --json --since 1h        # one classified failure per line
```

The fleet makes tens of thousands of tool calls a day and a few percent of
them fail. Most failures belong to the agent's own work, and nothing on this
machine can help with them. A minority are the machine refusing a call
it could have served, such as a missing Python library, a cap that rejects
instead of clamps, or a service restart. Those are worth an afternoon each.
Separating them from the noise by hand costs an afternoon on its own.

The output groups failures by owner:

- **Machine.** A missing module, dead service, permission denial, or OOM. Fix
  these.
- **Interface.** A tool refused work it could have served or returned an error
  that taught the caller nothing. These are often cheap to fix.
- **Workload.** The work hit its bound, usually the 55-second bash cap. Improve
  or divide the work.
- **Agent.** The agent's own work failed. This should be the largest group in
  a healthy day.

## Where it reads

`/var/lib/pi-orchestrator/runs/*/events.jsonl`, the orchestrator's shared
per-run transcripts (`PI_ORCHESTRATOR_RUNS` overrides the directory). The
runner prunes those after seven days, which is the whole history available;
`--since 1w` is the widest useful window. `pi-orch` group membership is what
grants read access, so this runs as `kenan` with no elevation. The fleet
user's own session store under `/home/orchestrator/.pi` is deliberately not
read: it sits behind a 0700 home, and the run transcripts are the interface
built for exactly this.

## Classification

`RULES` in the script is an ordered list of `(kind, name, regex)`, first match
wins, and everything unmatched lands in *the agent's own work*. That default
is the honest one. A task failure is not a machine fault, and a taxonomy that
tries to name every one will be wrong more often than useful.

Add a category when you have looked at a cluster and know what it means.
`--show` prints the calls behind any category, which is how you find out
whether a cluster is one bug or ten unrelated failures. Put specific patterns
above general ones; the ledger wraps most of its errors in `{"error": …}`, so
anything more precise than that has to come first.
