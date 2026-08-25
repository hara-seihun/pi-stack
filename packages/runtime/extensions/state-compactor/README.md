# State compactor

State compactor keeps Pi's native compaction and triggers it earlier, at 250,000 context tokens.

It registers one `before_provider_request` handler. When `ctx.getContextUsage()` reaches the threshold, the handler calls `ctx.compact()` once and waits for Pi's completion or error callback before it can trigger again. Missing usage data and smaller contexts pass through unchanged.

The extension does not transform context, replace Pi's summary, or add continuation messages. Pi aborts the pending agent operation when compaction starts, and the request does not resume automatically.

## Test

```sh
node --test extension.test.mjs
```
