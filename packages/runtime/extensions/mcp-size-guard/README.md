# mcp-size-guard

Files a machine alert when an MCP tool answers with an absurd amount of data.

A tool that returns a megabyte has an unbounded field in its response — a log,
an axiom list, a whole artifact body pasted into a list row. Nothing breaks
loudly when that happens: pi's output guard truncates the text before the model
sees it, the agent reads a sensible-looking answer, and the defect stays
invisible until someone goes looking. The one that prompted this extension was
`review_queue` on the math ledger answering a one-row question with **13.5 MB**,
because twenty verification failures each carried a full `native_decide` axiom
list. It was found by accident, in passing, while fixing something else.

So the condition announces itself now, in
[the alerts inbox](/home/kenan/machine/observability.md#alerts-inbox).

## Behavior

- **Trigger:** one MCP response over **1 MiB**. `PI_MCP_SIZE_ALERT_KB` sets the
  threshold in kilobytes.
- **Measurement:** the sizes pi's MCP output guard already computed —
  `outputGuard.originalBytes` (the text before truncation) and
  `mcpResult.rawResultBytes` (the raw JSON-RPC result before it was summarized).
  The larger is what crossed the wire. Nothing is re-serialized to measure it.
- **Alert:** server, tool, size, the call's arguments, and the path of the file
  pi already spilled the whole response to, which is the evidence the next agent
  needs to find the unbounded field.
- **One alert per tool:** while an unconsumed alert for the same server/tool sits
  in the inbox, repeats file nothing. Deleting the file re-arms it, which is what
  makes deletion mean "looked at". The key is the greppable `- key: mcp-oversize
  <server>/<tool>` line in the body.
- **Never in the way:** the handler returns the tool result unmodified and
  swallows its own failures to stderr. A broken inbox must not cost a tool call.

## Why 1 MiB

The inbox is for conditions that must be fixed, explicitly not a log stream, so
the threshold has to sit above everything legitimate. Measured against the math
ledger, the only MCP server registered on this host — every one of these is a
healthy call:

| response | call |
|---|---|
| 20.6 KB | `hello` |
| 55.3 KB | `review_queue` default page |
| 85.5 KB | `review_queue {limit: 50}` |
| 86.5 KB | `get` on the largest entry in the corpus |
| 95.9 KB | `news {}` |
| 644 KB | `query`, 500 rows of id+title+summary (500 is the documented row cap) |
| 1.6 MB | `query`, 20 whole artifact bodies |
| 5.0 MB | `query`, 100 whole artifact bodies |

Against 13.5 MB for the incident. A 100 KB threshold was considered and rejected
on this evidence: `news` alone would cross it, and an inbox that fills up gets
emptied without being read, which costs the channel the one alert that mattered.
A megabyte leaves healthy traffic room to grow and still catches the condition by
an order of magnitude. Set `PI_MCP_SIZE_ALERT_KB` lower while hunting something
specific.

The last two rows are the honest limit of a pure size rule: `query` returns
whatever SELECT the caller wrote, so its size is authored by the caller, like an
mcpScript that emits everything it fetched. Bulk-reading a hundred documents
trips this and nothing is broken. There is no per-tool exemption list, because
an empty-by-default list naming one tool on one server is config that rots; the
alert instead tells the reader to check the arguments first, and a caller-sized
response is resolved by deleting the file. Only a small request that came back
enormous is a defect.

## Waste is a different question

This guard answers "is a tool broken?", not "is this call wasteful?". Responses
between 50 KB and the threshold are truncated in front of the agent who asked,
which is feedback delivered to the only party who can act on it. If per-call MCP
size ever needs watching as a trend, that belongs in the usage ledger beside the
other telemetry, not in an inbox reserved for things that must be fixed.

## What it does not see

`mcpScript` calls several MCP tools inside one pi tool call. The adapter measures
each inner response (that is where the 13.5 MB figure above came from) but its
`calls[]` trace records only path, ok, and duration, so the inner sizes never
reach a `tool_result` the extension can read. An oversized response inside a
script is therefore invisible here, and the same tool called through
`mcp({tool})` alerts normally.

Closing it takes one upstream change — carry `bytes` alongside `durationMs` in
the mcpScript call snapshot in `pi-mcp-adapter/mcp-code.ts` — and then a few
lines here. It was not worth forking the adapter for, because a tool that
returns a megabyte inside a script returns a megabyte outside one soon enough.

Also out of scope by design: the size of what an `mcpScript` *emits*. That is the
agent's own script being greedy, it is truncated in front of the agent who wrote
it, and nothing about it needs fixing by anyone else.

## Escape hatch

`PI_MCP_SIZE_GUARD=off` in the environment registers nothing.

## Tests

```bash
node --test
```

The last test drives the real `alert` CLI into a temporary inbox, so it proves
the whole path rather than the formatting.
