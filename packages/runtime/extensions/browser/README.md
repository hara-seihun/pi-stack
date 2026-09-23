# Browser runtime

This entrypoint loads upstream `pi-agent-browser-native` and puts the matching dependency tree's `.bin` first in the Pi process's `PATH`. Both package versions are pinned in the [stack manifest](../../../../package.json) and installed together by `deploy/runtime`.

It resolves physical paths before registering the tool. Changing `/srv/pi/runtime` or `~/.local/bin/agent-browser` during a turn cannot change that process's browser executable or native module. Interactive Pi, Pi Remote and embedded fleet sessions all load this entrypoint through the configured package list. A new or reloaded session selects a new pair together, including a recovered worker whose Orchestrator code is from an earlier release. Pi's [extension loader patch](../../../../vendor/pi/README.md) resolves the selected physical entrypoint before import. Clearing Pi's factory cache alone does not clear Node's native ESM symlink cache.

The supported hosts run one Pi session per process. An SDK application needing simultaneous sessions on different dependency generations must give them separate processes because executable resolution uses the process environment.

The native tool, commands, session state, cleanup and browser configuration remain upstream-owned. This entrypoint does not wrap tool calls or alter their schemas. Browser profiles and credentials stay in their existing locations outside the release.

The native tool documentation lives under `/srv/pi/runtime/node_modules/pi-agent-browser-native`. The stack owns the normal `pi-agent-browser-doctor` command. Upstream's doctor only recognizes its own package paths and recommends an npm installation when it sees this entrypoint. That advice would recreate mutable package state, so the stack's doctor checks actual Pi registration and the native tool instead.

The release-switch tests cover a continuing process, a fresh process, SDK reload, and bundled RPC reload through a configured package path. Both reload tests switch forward and roll back. The executable fixtures distinguish versions without needing Chromium in CI.

[`browser-doctor.mjs`](../../browser-doctor.mjs) loads the deployed native tool through normal settings, rejects missing or duplicate registrations, opens a loopback page, takes an interactive snapshot, checks its title, saves and verifies a PNG screenshot, and verifies isolated-browser cleanup. It makes no model request and uses no signed-in profile. The native version guard remains in force. Deployment installs the doctor into the immutable dependency tree, includes its source in the tree's identity, and runs it before service activation. It can also prove recovery using a recorded worker release and a copy of a settled session's JSONL. See [deployment and recovery](../../../../docs/deployment.md#browser-recovery).
