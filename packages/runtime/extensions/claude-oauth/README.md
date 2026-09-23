# Claude OAuth runtime

This entrypoint loads upstream `@pi-plugins/claude-oauth` 0.3.7 from the release's immutable dependency tree. [`client.json`](client.json) owns the advertised Claude Code version, currently 2.1.280. [`patch-claude-oauth.mjs`](../../patch-claude-oauth.mjs) updates the upstream version constant before deployment, so its user-agent, billing header and version-dependent fingerprint agree. The upstream request checksum, SDK version and other request behavior stay unchanged.

On September 22, 2026, Anthropic rejected Opus 5.5 with `claude_code_version_too_old`: upstream 0.3.7 still advertised 2.1.251, while the model required 2.1.280. A real pooled Opus 5.5 request succeeded after changing that constant, response `msg_011CfJvPQFDJf9gRo5yG71JC`.

[`deploy/runtime`](../../../../deploy/runtime) includes the patch and client metadata in the dependency hash, applies the patch before publishing the tree, and checks the result on reused releases. The entrypoint refuses an unpatched dependency. [`config/packages.json`](../../../../config/packages.json) places this entrypoint after the Anthropic beta guard and replaces the per-account npm adapter. Active runtimes retain their physical dependency generation until they settle.

To update the adapter, review the pinned upstream package and `client.json`, run the [adapter/guard tests](../anthropic-beta-guard/guard.test.mjs), then deploy the stack and make a real Opus request. A plugin version alone does not prove that Anthropic accepts its advertised client version. When upstream supplies the required version, remove the build patch and its deployment wiring together.

The entrypoint has no persistent state. Source and the lockfile reproduce its dependency tree; do not edit an installed npm copy or a published runtime tree.
