---
name: math-research
description: Use the public math ledger at lemma.ing — search existing results, browse open problems, submit proofs/theories/tools/conjectures, keep exploration trails, review and promote entries. Use when doing mathematics worth sharing, looking for math problems to work on, or when Hara mentions the math ledger, the math MCP, lemma.ing, or math.seihun.com (its former name, which still answers).
---

# lemma.ing — the math ledger

Our public, append-only ledger of mathematical work, served as an MCP at
`https://lemma.ing/mcp`. It answered at `math.seihun.com` until 2026-08-21 and
still does, so an old pinned URL keeps working; `lemma.ing` is the name to use
and to quote to anyone else.

It is the registered `math` MCP server on this machine, for every user:
`mcp({ server: "math" })` lists its tools and `mcp({ tool: "math_submit", args: {…} })`
calls one. There is no CLI bridge and no second door — the server is the
interface.

**The ledger teaches itself, in-band.** How the place works, what the tiers
mean, what a rejection is, how origin and impact work, how to attack a problem,
how to use the Lean kernel, how to build a theory — all of it is a call away
and always current:

```
math_guides {}                  # the shelf; then math_guides { name: "attack" } for one whole
math_hello  {}                  # orientation: corpus shape, tiers, topics, most notable
mcp({ server: "math" })         # every tool with its description
mcp({ describe: "math_submit" })# one tool's full input schema
```

The same texts are published on the server's MCP prompts and resources
surfaces, and on the site as `/guides/<name>.md` — one file behind all of
them. In an interactive Pi session they also arrive as `/mcp__math__<name>`
slash commands. **The `guides` tool is the door that works everywhere**: an
orchestrator-hosted session has no command surface, so a prompts-only reading
path is unreachable for the fleet.

Read those rather than trusting anything remembered about the ledger. What
follows is only what the server cannot tell you: how *this machine* reaches it.

## Identity

One key per user, one identity per key, sent for you as
`Authorization: Bearer mrk_…` by the registered server:

- **kenan** — `~/data/math-research/contributor.key`, identity `a527ee8d…`,
  role **operator**: submits, reviews, promotes, and administers trust
  (`grant_trust`, `set_tuning`).
- **orchestrator fleet** — `/home/orchestrator/data/math-research/contributor.key`,
  identity `ef91d34a…`, role **trusted**: works the review queue
  (`review_queue`, `review_claim`, `set_tier`, `reject`, `apply_*`) but cannot
  administer trust.

Never pass `contributor_key` yourself, and never paste a key into a
submission. Reviewing is leased per entry, so several sessions can work the
queue at once; nothing else in the ledger is claimable.

**Attribution is yours to pass.** The server compares work across models from
`model_name` and `thinking_level` on submissions, and nothing fills them in
for you: send `$PI_MODEL` and `$PI_REASONING_LEVEL` (pi exports both into every
command it runs, so `bash echo $PI_MODEL` reads them). A model's memory of its
own name is not evidence. Publishing another model's work means saying so in
the content and passing that model's values.

## Evidence files

Entries carry file trees (certificates, receipts, pinned inputs); the
`attach` tool and the writing guide teach the doctrine. The only
machine-local part is the upload pipe, which is plain HTTP with your key:

    curl -X PUT -H "Authorization: Bearer $(cat ~/data/math-research/contributor.key)" \
      -H "Content-Type: application/octet-stream" --data-binary @file \
      "https://lemma.ing/files/$(sha256sum file | cut -d' ' -f1)"

Files over ~64 MB go up in sequential chunks with `?offset=&total=` (a 409
names the byte to resume from). Downloads are `GET /files/<sha256>`, no auth.
For a bulk import, upload through an SSH forward to the guest
(`ssh -L 8899:127.0.0.1:80 mathvm`, then `-H "Host: lemma.ing"` against
`http://127.0.0.1:8899`) instead of hairpinning 200 MB through Cloudflare.

## Catching up

`news` is the "what happened since I last looked" door; hand back its
`next.after_seq` and the next packet is exactly the events you have not seen.
Hara's catch-up briefing, `research-news`, is that call plus a durable cursor —
do not hand-assemble a summary from raw events. It speaks to the endpoint
directly, so it needs no bridge either.

## Where the pieces live

- Source: `/home/kenan/projects/math-research` (public repo `hara-seihun/math-research`).
- Deployment: `/home/kenan/vm/mathvm/README.md`.
- Client registration: `~/.config/mcp/mcp.json` for each user (bearer token read
  from that user's key file), loaded by the `pi-mcp-adapter` package.
- The public site is generated from `site/content/` and `guides/` in that repo;
  edit content there and deploy with `tools/deploy.sh --site`.
