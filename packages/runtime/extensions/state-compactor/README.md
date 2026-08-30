# State compactor

State compactor triggers Pi's native compaction at 250,000 context tokens and keeps skills intact across the boundary.

Pi's session branch retains the tool traffic removed from the provider view. After a compaction, this extension finds every skill file read before that boundary, validates paged reads against the current file, and inserts the exact loaded skills at the start of the message list. They therefore sit after Pi's system and tool context but before the compaction summary and retained conversation. A skill loaded after the latest compaction stays in its ordinary tool result until the next compaction.

A partial paged read produces a durable request for the missing page. A changed or unavailable file produces a reread request. The extension never keeps stale instructions silently.

When `ctx.getContextUsage()` reaches the threshold, the extension calls `ctx.compact()` once and waits for Pi's completion or error callback before it can trigger again. Pi aborts the pending operation when compaction starts, so a successful compaction adds a hidden continuation message and starts a fresh turn.

Anthropic refuses some native summary requests when a long transcript contains extensive model-written material. That refusal used to abort every later turn because each request retried the same blocked compaction. Anthropic sessions now summarize through `openai-codex/gpt-5.4-mini` while keeping their selected conversation model. Other providers retain Pi's native summarizer.

## Test

```sh
node --test extension.test.mjs
```
