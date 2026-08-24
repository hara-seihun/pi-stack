# MCP size guard

Reports unexpectedly large MCP responses while leaving Pi's normal output guard responsible for truncation.

## Configuration

- `PI_MCP_SIZE_GUARD=off`: disable the extension.
- `PI_MCP_SIZE_ALERT_KB`: reporting threshold in KiB; defaults to `1024`.
- `PI_MCP_SIZE_ALERT_COMMAND`: executable invoked as `command <title> <body>`. Without one, reports go to stderr.
- `PI_MCP_SIZE_ALERTS_INBOX`: optional directory read to suppress duplicate, still-unconsumed reports.

The command and inbox are host integration points. This package does not assume an alert system or filesystem layout.

## Test

```sh
node --test guard.test.mjs
```
