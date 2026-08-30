# Scratch updates

This Pi extension registers `scratch_updates`, a parameter-free tool that reads both `math_scratch_recent_activity` and `math_scratch_recent_workspace_activity` through the machine's standalone `mcp` command.

Each successful call reports published activity after the preceding call began, then stores that invocation time in `~/.local/state/pi-runtime/scratch-updates.json`. The first call starts one hour earlier. The checkpoint is shared by this user's Pi sessions, including Pi Remote threads. MCP errors do not move it.

The result covers workspace creation, guide edits, notes, and changed file paths as well as published advancement. It groups working activity by workspace so a busy fleet remains readable. Each MCP read has a 100-entry bound. If either source cannot return the complete window, the tool labels its result partial and leaves the checkpoint unchanged rather than silently skipping work.

Set `PI_SCRATCH_UPDATES_STATE` to choose another checkpoint path. The host must provide an authenticated `math_scratch` MCP registration and `mcp` on `PATH`.

Run the focused test with:

```sh
node --test scratch-updates.test.mjs
```
