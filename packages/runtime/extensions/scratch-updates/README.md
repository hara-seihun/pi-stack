# Scratch updates

This Pi extension registers `scratch_updates`, a parameter-free tool that reads the `math_scratch_recent_activity` MCP operation through the machine's standalone `mcp` command.

Each successful call reports published activity after the preceding call began, then stores that invocation time in `~/.local/state/pi-runtime/scratch-updates.json`. The first call starts one hour earlier. The checkpoint is shared by this user's Pi sessions, including Pi Remote threads. MCP errors do not move it.

The MCP feed has a 100-entry bound. If 100 newer entries fill the window before it reaches the saved checkpoint, the tool labels its result partial and leaves the checkpoint unchanged rather than silently skipping publications. Workspace notes and file writes are absent because the server's published activity feed deliberately excludes them.

Set `PI_SCRATCH_UPDATES_STATE` to choose another checkpoint path. The host must provide an authenticated `math_scratch` MCP registration and `mcp` on `PATH`.

Run the focused test with:

```sh
node --test scratch-updates.test.mjs
```
