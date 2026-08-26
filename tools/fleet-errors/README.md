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
them fail. Most of those failures are the mathematics being hard, and nothing
on this machine can help with that. A minority are the machine refusing a call
it could have served — a missing Python library, a cap that rejects instead of
clamping, a service that was restarting. Those are worth an afternoon each,
and separating them from the noise by hand costs an afternoon on its own.

So the output is grouped by whose fault a failure is:

- **machine** — broken here: a missing module, a dead service, a permission
  denial, an OOM. Fix these.
- **interface** — a tool refused a call it could have served, or produced an
  error that taught the caller nothing. Usually the cheapest wins.
- **workload** — the work did not fit the bounds it was given, mostly bash
  calls hitting the fleet's five-minute cap. A signal about task sizing, not a
  defect.
- **agent** — the agent's own code and mathematics. Expected, and the largest
  group in a healthy day.

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
wins, and everything unmatched lands in *the agent's own code or mathematics*.
That default is the honest one — a failing census or a broken proof is not a
machine fault, and a taxonomy that tries to name every one of them will be
wrong more often than useful.

Add a category when you have looked at a cluster and know what it means.
`--show` prints the calls behind any category, which is how you find out
whether a cluster is one bug or ten unrelated failures. Put specific patterns
above general ones; the ledger wraps most of its errors in `{"error": …}`, so
anything more precise than that has to come first.

## What it found the first time

Run on 2026-08-22 over three days of fleet transcripts, out of 6,190 failed
calls in 132,000:

- 181 calls asked a ledger tool for more rows than its cap and got a
  validation error instead of a page, a number that was rising daily.
- 124 hit `ModuleNotFoundError`, and 59 of those were the `fast-math` Python
  wrapper prefixing the published copy ahead of a caller's own checkout.
- 262 hit the ledger while an instance was restarting, because its drain
  could stall and systemd's kill was what actually ended it.
- 192 were shell-quoting failures from hand-quoting JSON into the `math-mcp`
  CLI, which had already been deleted by then — a category that disappears on
  its own tells you the fix landed.

Each of those became a change. The taxonomy is worth re-running after any of
them, since a category that stops appearing is the only real confirmation.
