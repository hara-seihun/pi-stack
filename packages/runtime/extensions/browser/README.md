# Browser runtime

This entrypoint loads upstream `pi-agent-browser-native` and puts the matching dependency tree's `.bin` first in the Pi process's `PATH`. Both package versions are pinned in the [stack manifest](../../../../package.json) and installed together by `deploy/runtime`.

It resolves physical paths before registering the tool. Changing `/srv/pi/runtime` or `~/.local/bin/agent-browser` during a turn cannot change that process's browser executable or native module. Interactive Pi, Pi Remote and embedded fleet sessions all load this entrypoint through the configured package list. A new or reloaded session selects a new pair together, including a recovered worker whose Orchestrator code is from an earlier release.

The native tool, commands, session state, cleanup and browser configuration remain upstream-owned. This entrypoint does not wrap tool calls or alter their schemas. Browser profiles and credentials stay in their existing locations outside the release.

`pi-agent-browser-doctor` is deployed beside `pi` and `agent-browser`. Its source and the native tool documentation live under `/srv/pi/runtime/node_modules/pi-agent-browser-native`.

The release-switch test starts two real Node processes against different dependency trees. The first keeps its executable after the selected release changes; the second loads the new pair.
