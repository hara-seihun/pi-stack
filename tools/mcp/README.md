# mcp

`mcp` is the machine's standalone Model Context Protocol client. It replaces the Pi MCP extension and keeps MCP schemas out of every model request. Agents invoke it through `bash` when they need an MCP server.

```bash
mcp status
mcp search 'review queue'
mcp describe tracker_review_queue
mcp call tracker_review_queue '{"claim":false}'
printf '%s\n' '{"query":"CI","limit":5}' | mcp call tracker_search
```

The client merges the standard global and project config files in this order:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json`
3. `$PI_AGENT_DIR/mcp.json`
4. `.mcp.json`
5. `.pi/mcp.json`

Later definitions win. HTTP and stdio servers are supported. A `bearerToken` or header value beginning with `!` runs the rest of the value as a command and uses its trimmed stdout, so credentials stay outside config files. The current machine servers use bearer or unauthenticated HTTP. OAuth server login is deliberately not claimed: the command returns a direct error if an OAuth definition is encountered.

A tool call that the server refuses comes back as an ordinary MCP result carrying `isError`, not as a transport failure. `mcp call` prints that result and exits non-zero, so a rejected call fails in a shell loop instead of reading as success.

Output is meant to be piped. A reader that leaves early, as `mcp list issue_tracker | head` does, ends the command quietly with status 0 rather than printing an EPIPE stack trace over what you were reading.

`mcp` opens connections only for one invocation and closes them before exit. Use [`mcp-script`](../mcp-script/README.md) when several calls need one process and JavaScript control flow.

After CI accepts the commit, run `../../deploy/tools local`. It publishes the reviewed source under `/srv/pi/tools/mcp`, reuses Pi Runtime's production dependencies, and links `mcp` into both users' `PATH`. Configuration and credentials remain per-user.
