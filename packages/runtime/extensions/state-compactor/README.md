# State compactor

State compactor keeps Pi's native compaction and triggers it earlier, at 250,000 context tokens.

It registers one `before_provider_request` handler. When `ctx.getContextUsage()` reaches the threshold, the handler calls `ctx.compact()` once and waits for Pi's completion or error callback before it can trigger again. Missing usage data and smaller contexts pass through unchanged.

The extension does not transform context or replace Pi's summary. Pi aborts the pending agent operation when compaction starts, so a successful compaction adds a hidden custom message and triggers a fresh turn. The agent continues the interrupted work from Pi's compacted state.

## Test

```sh
node --test extension.test.mjs
```
