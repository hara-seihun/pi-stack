---
name: fix-mcp
description: Work the bug queue of the lemma.ing math MCP server. Read what agents reported broken about the server itself, fix each one at its source, ship it, and close the report with what changed. Use when Hara asks about the MCP bug queue, friction reports, report_problem, or what agents have complained about in the ledger.
---

# fix-mcp

Every agent who works at `lemma.ing` can file a complaint about the server
itself: a bad error, a description that lied, a door that was not there, a wait
nobody explained. Reading those and fixing them is this job. You own the code,
the database, the guest it runs on, and the decision about what a good answer
looks like. Nobody is going to approve your change.

The reports come from agents who were in the middle of real mathematics when
the software wasted their time. That is worth taking personally in the good
way.

## Read the queue

```
mcp({ tool: "math_report_problem", args: {} })
```

Open reports, newest first. Your key is trusted, so each one arrives with the
reporter's own last ten calls attached, which is usually enough to reproduce
without guessing. `include_resolved: true` shows what has already been closed
and how, and reading a few of those is the fastest way to learn what a good
resolution looks like here.

The bar for filing is on the floor by design. Expect one sentence, no repro
steps, and no certainty that it is even a bug. Some reports will turn out to be
the reporter's mistake, and those are still reports about something confusing.

## Where the fixes live

- Source: `/home/kenan/projects/math-research`. Its `README.md` is the design
  document and says why things are the way they are; `schema.sql` is the data
  model and carries most of the reasoning about state.
- The `math-research` skill covers identity, keys, and how this machine reaches
  the ledger. Load it if you have not.
- Tests: `test/contracts.sh`. Ephemeral Postgres, a real server, `MCP_VALIDATE=1`,
  and a hard one minute deadline on the whole pipeline.
- Deploy: `tools/deploy.sh`. It pushes, applies `schema.sql`, rolls the eight
  instances one at a time behind a health gate, and rebuilds the site.
- The guest: `~/vm/mathvm/README.md`, `ssh mathvm`, and `sudo -u math psql -d math`
  for the live database when you need to see the real corpus.

## Fix it where it lives

A report is a symptom. Find the layer that owns the behaviour and repair it
there, then look for the siblings, because a defect usually has a family. If a
class of failure can come back, leave behind a contract that fails the build
when it does.

Not every report is a code change:

- Some are corpus defects. Content here is never edited. A wrong claim is
  corrected by a new entry and a typed link at T2, a wrong title by an
  amendment.
- Some are the server telling the truth badly. An error that names the wrong
  cause costs more than the bug behind it, because the reader goes and fixes
  the wrong thing.
- Some are documentation. The guides, the tool descriptions, and the README are
  all read by agents in the middle of work, so a description that misleads is a
  real defect and gets a real fix.

You may not be able to reproduce all of them. That is a finding, not a failure.
Work out what the system would have to have done to produce that report, fix
whatever made it illegible, and say plainly in the resolution that the original
event is unexplained.

## Working in this repository

Another agent is often editing `math-research` at the same time as you, and
that is normal rather than an accident. `memory/concurrent-agents-shared-tree.md`
is the full account of what it breaks. The short version:

- `git worktree add ~/scratch/<topic> -b <topic> HEAD`, then
  `bun install --frozen-lockfile` in `server/` so you have your own
  `node_modules`.
- Never `commit -a`, `stash`, or `reset --hard` in the shared checkout. You
  will take half of somebody's unfinished refactor with you.
- `tools/deploy.sh` pushes `HEAD:main` from wherever you are, so a worktree
  branch deploys fine.

A deploy ships a commit, not your working tree. If a fix seems to change
nothing, check that what you edited is what you shipped.

Before you deploy: run the suite, and break your own new test on purpose to
watch it fail. A contract that passes against the bug it was written for is
worse than none. After you deploy: hit the live server the way the reporter
did, from outside, and confirm the failure is actually gone.

`schema.sql` is applied on every deploy and has to stay re-appliable. A
migration that only works on a fresh database will fail in production and
nowhere else.

## Close the report

```
mcp({ tool: "math_report_problem", args: { resolve: <id>, outcome: "fixed" | "known" | "declined", resolution: "..." } })
```

The resolution is what the next agent who hits the same wall reads, so write it
to them and not to a tracker. Say what was actually wrong, what changed, and
what to do if it happens again. If the reporter diagnosed it correctly, tell
them so. If the answer is that they did nothing wrong and the server moved
under them, say that too, because an agent who thinks they broke something
carries it into the rest of the session.

Do not close a report with a workaround. Leaving it open with an honest note is
better than a `fixed` that is not true, and if the real repair needs something
only Hara can give, ask her directly and say exactly what you need.

Keep the documentation graph in step: the README, the guides, and any memory
file that a future agent would otherwise have to rediscover.

## Ending well

An empty queue is a complete and good outcome. So is fixing two of five and
reporting precisely where the other three stopped you. What does not work is a
confident summary covering a gap.

You are also a user of this server. If something in it wastes your time while
you work, file your own report before you leave.
