# Claude reset and quota collector

`claude-reset` collects **read-only** Claude web grant balances and quota usage into the Pi Orchestrator ledger. It does not redeem resets or make POST requests. The host owns the Kernel profiles, JSON map, schedule, and ledger; this repository owns the collector.

```json
{
  "anthropic": "claude-profile-one",
  "anthropic-2": "claude-profile-two",
  "anthropic-3": "claude-profile-three"
}
```

The keys are ledger account IDs and the values are names of **existing** Kernel profiles; the profile names above are fictional. Put the map in a host-owned JSON file (for example `/etc/pi-stack/claude-resets.json`) and provision its schedule through the host's systemd configuration. NixOS hosts can declare the same file and schedule in their configuration. Each ledger Anthropic account must have its Claude web email as its label. This label is an identity check, not a token.

```sh
claude-reset --config /etc/pi-stack/claude-resets.json
claude-reset status --config /etc/pi-stack/claude-resets.json --json
claude-reset --config /etc/pi-stack/claude-resets.json --dry-run --account anthropic
```

Default `collect` starts each mapped profile with `kernel-browser start`, reads `GET /api/organizations`, `GET /api/account` (`email_address`), and `GET /api/organizations/{uuid}/usage?cedar_ember=1&skip_spend=1` with `kernel browsers curl`, then always stops its session. It accepts exactly one organization, verifies the account email against the ledger label, and totals unpaused, unexpired `cedar_ember.grants[*].resets_left`; `ends_at` supplies the nearest expiry. The same usage response's `limits` array is parsed by Orchestrator's `parseAnthropicUsage`, mapping session, all-model weekly and Fable-scoped weekly limits to the ordinary `anthropic-5h`, `anthropic-7d` and `anthropic-7d_oi` meters. It never infers zero usage from a redeemed grant or reads the older top-level usage fields. Collection therefore reconciles quota immediately after a reset instead of waiting for the OAuth meter poll.

Only successful, identified responses with readable quota limits update the ledger. `Store.recordResetCredits(accountId,{at,available,nextExpiresAt})` and `Store.recordReading` for each parsed meter share an observation timestamp and one transaction. Percentages are rounded and bounded to 0–100 as in the OAuth sampler. A failed read, identity check, session stop or ledger transaction exits nonzero and retains the previous balance and meters. Unreadable or unmapped buckets never become zero readings; parsed buckets are recorded and unmapped model scopes are exposed in JSON. The collector does not change account cooldowns. `status` reads the last-known balance without starting browsers; `--dry-run` makes the authenticated reads but does not write. `--json` emits per-account results, including parsed `meters` and `unmappedScopes` for successful collection. `--account ID` filters the map and is repeatable.

`CLAUDE_RESET_CONFIG` substitutes for `--config`; `PI_ORCHESTRATOR_LEDGER` overrides the default `/var/lib/pi-orchestrator/ledger.sqlite3`, and `PI_ORCHESTRATOR_STORE` overrides `/srv/pi/pi-orchestrator/dist/store.js`. The tool reads the deployed Store module and its sibling `meters-anthropic.js`, so deployment must provide both modules and allow the invoking account to update the ledger. Kernel owns browser credentials; none are stored in the map or collector.

Run the focused collector contract test without browsers or a live ledger:

```sh
node --test tools/claude-reset/collect.test.mjs
```
