# Pi runtime roadmap

This repository is the pinned Pi deployment plus the locally owned extensions and
prompt evaluation. The 2026-08-19 decommission removed the orchestrator,
Multi-Pass, the Pi usage logger, and plan-meter from this repository: autonomous
launch, account custody, and machine-wide usage telemetry now live in the public
ground-up rebuild at [`~/projects/pi-orchestrator`](../../projects/pi-orchestrator/README.md)
(`hara-seihun/pi-orchestrator`), which fulfilled the former packaging goal for
that layer by being born public instead of being extracted.

## Publish the remaining extensions as versioned packages

### Scope: what becomes a package

| Component | Today | Notes |
|---|---|---|
| [`extensions/context-guard/`](extensions/context-guard/README.md) | directory symlinked into `~/.pi/agent/extensions` | pi extension |
| [`extensions/chatgpt-pro/`](extensions/chatgpt-pro/README.md) | symlinked directory + `pro` executable | pi extension, Kernel browser bridge |
| [`extensions/pi-claude-code-use/`](extensions/pi-claude-code-use/README.md) | local package path, deliberately shadowing an npm package | pi extension |
| [`prompt-eval/`](prompt-eval/README.md) | symlinked CLI | may publish separately |

### Requirements

1. **Published artifact.** Public npm packages, source public on `hara-seihun`. Needs a package scope,
   a licence, a public README per package written for a reader with none of our context, and a
   contribution/issue posture. Our installations then consume the same public versions as anyone else;
   there is no private fork path.
2. **Semantic versions and a release command.** One command tests, versions, publishes, and tags. A host
   updates by installing a version, never by pulling a branch.
3. **Factor out every machine-specific behavior.** Known items to remove or generalize:
   - **Alerts inbox as a machine surface.** context-guard writes to a private directory this machine's
     agents poll. Published behavior needs a general reporting hook (callback, log, or configured path)
     with the inbox as one local configuration.
   - **Our account naming and subscription policy.** `openai-codex-N` provider-index conventions,
     `chatgpt-pro-profiles.json`, the pi-orchestrator ledger path, the Kernel browser bridge, and
     model-policy bans on specific models belong in configuration, not in package code.
   - **Our operating policy in prompts and docs.** Component READMEs quote this machine's paths,
     research campaigns, and quota anecdotes. Public docs describe the mechanism; machine-specific
     operating detail moves to [`machine/pi.md`](../../machine/pi.md) and this repository's private
     deployment notes.
   - **Secrets and identities.** Verify no account label, subscription identity, tailnet name, IP, or
     credential path reaches the public artifact — including test fixtures and committed sample state.
4. **Pinned upstream compatibility.** Each package declares which `@earendil-works/pi-coding-agent`
   versions it supports and fails clearly on an unsupported one, so a runtime upgrade cannot silently
   break the extension API surface it depends on.
5. **Prove the factoring worked.** A clean checkout must pass its tests on a host with a different user,
   home directory, and hostname, with no `/home/kenan` present. Grepping the published tree for this
   machine's paths, hostnames, account labels, and unit names returns nothing.
