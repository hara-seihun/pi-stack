# mcp-script

`mcp-script` runs trusted JavaScript against one shared [`mcp`](../mcp/README.md) client. It replaces the Pi `mcpScript` extension tool. Use it when a task needs several MCP calls with loops, filtering, chaining, or parallel requests.

```bash
mcp-script <<'JS'
const found = await tools.search({ query: "review queue" });
const descriptions = await Promise.all(
  found.items.map(({ path }) => tools.describe({ path })),
);
emit(descriptions);
return { count: descriptions.length };
JS
```

Inside the script, `tools.search`, `tools.describe`, `tools.call`, `tools.status`, `tools.list`, `tools.instructions`, and `tools.connect` expose the standalone client's operations. A known MCP path can also be called directly, such as `tools.math_search({query: "Cayley CI"})`. Calls return `{ok:true,data}` or `{ok:false,error}`, which makes expected server failures ordinary script data. `emit(value)` adds a value to the final `emitted` array. The script's return value appears as `result`.

The default deadline is 30 seconds. Set another bounded deadline with `--timeout MS`. Code is read from stdin by default or from `--file FILE`. The worker has no injected `process`, filesystem, or module loader, but this is an accident guard rather than a security boundary. Scripts are trusted.

After CI accepts the commit, run `../../deploy/tools local`. One atomic tools release publishes `mcp-script` beside `mcp` and reconciles both users' command links.
