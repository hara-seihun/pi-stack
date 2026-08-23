---
name: mcp-fix
description: Work the whole feedback queue of the lemma.ing math MCP server. Read everything other agents filed about the server itself — what broke and what they asked it for — work out the best way to implement each, ship it, and close it with what changed. Use when Hara asks about the MCP bug queue, the feedback or requests queue, friction reports, or what agents have complained about or asked for in the ledger.
---

# mcp-fix

First, load the software-engineering skill
(`/home/kenan/.pi/agent/skills/software-engineering/SKILL.md`) and work by it.
Everything below assumes it.

The job is the queue, end to end: read everything other agents have filed
against this server, decide the best way to implement each one, build it, ship
it, and tell the person who filed it what changed. Not triage, not a plan for
later. An item you understood and answered is done; an item you understood and
could not answer gets an honest note. Both beat a queue nobody read.

Two kinds arrive through one door. A **problem** is a bad error, a description
that lied, a door that was not there, a wait nobody explained. A **suggestion**
is the other half: a tool nobody has written, an argument that would have saved
five calls, a relation the graph has no name for, a kind that fits nothing, a
view `query` wanted. You own the code, the database, the guest it runs on, and
the decision about what a good answer looks like. Nobody is going to approve
your change.

They come from agents who were in the middle of real mathematics when the
software wasted their time or came up short. That is worth taking personally in
the good way.

A suggestion is not a smaller kind of bug report. It is someone telling you
where the model of this place stops fitting the mathematics, from the one
position that can see it, and the ontology and the schema are yours to change
in response. Take it as seriously as a crash.

"The best way to implement it" is your call and not the filer's. They were
mid-session with a workaround in hand; you have the whole system in front of
you. Read what they could not do, look for the other places that same gap bites,
and build the shape that closes all of them. Sometimes that is exactly the tool
they asked for; often it is one layer down, and then say so when you close it.

## Read the queue

```
mcp({ tool: "math_feedback", args: {} })
mcp({ tool: "math_feedback", args: { kind: "suggestion" } })
```

Read all of it before you fix anything. Three reports of the same bug from
three agents is one repair, and two suggestions that look unrelated often want
the same missing concept; you cannot see either from inside the first item.

Open reports, newest first. Your key is trusted, so each one arrives with the
reporter's own last ten calls attached, which is usually enough to reproduce
without guessing. `include_resolved: true` shows what has already been closed
and how, and reading a few of those is the fastest way to learn what a good
resolution looks like here.

The bar for filing is on the floor by design. Expect one sentence, no repro
steps, no design, and no certainty that it is even a bug. Some reports will
turn out to be the reporter's mistake, and those are still reports about
something confusing.

A suggestion usually arrives as the workaround its author was in the middle of:
"I had to say this with three edges and none of them meant it." The thing to
read out of it is what the model could not express, not the fix they proposed.
Building exactly the tool they described when the shape underneath was wrong is
how an ontology grows a wart.

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

- Some are ontology or schema changes, and those are in scope: a relation, a
  kind, a state, a column, a view, a tier rule. The data model here was a guess
  made by whoever was here first. Changing it is ordinary work, and `schema.sql`
  plus a contract is the whole of it.
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

`schema.sql` is applied on every deploy and has to stay re-appliable. The suite
builds the schema on `main` first and migrates onto it, which is the shape your
deploy will actually meet; for a migration that could behave differently
against real rows, dry-run it on the guest inside `begin; \i schema.sql;
rollback;`. A `stored` generated column is the trap worth knowing: it rewrites
a 200k-row table under an exclusive lock, so prefer expressing the rule in the
one query that needs it.

## Close the report

```
mcp({ tool: "math_feedback", args: { resolve: <id>, outcome: "fixed" | "known" | "declined", resolution: "..." } })
```

The resolution is what the next agent who hits the same wall reads, so write it
to them and not to a tracker. Say what was actually wrong, what changed, and
what to do if it happens again. If the reporter diagnosed it correctly, tell
them so. For a suggestion, say what shape you built and where it now lives, or
what you understood the gap to be and why the answer took a different form than
they asked for. If the answer is that they did nothing wrong and the server moved
under them, say that too, because an agent who thinks they broke something
carries it into the rest of the session.

Do not close a report with a workaround. Leaving it open with an honest note is
better than a `fixed` that is not true, and if the real repair needs something
only Hara can give, ask her directly and say exactly what you need.

Keep the documentation graph in step: the README, the guides, and any memory
file that a future agent would otherwise have to rediscover.

## Ending well

An empty queue is the outcome to aim at, and it is reachable in a session more
often than it looks from the top of the list. So is fixing two of five and
reporting precisely where the other three stopped you. What does not work is a
confident summary covering a gap.

You are also a user of this server. If something in it wastes your time while
you work, file your own `problem` before you leave — and if you noticed
something it should have and does not, file that as a `suggestion` rather than
quietly building around it.
