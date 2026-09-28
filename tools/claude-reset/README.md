# Claude banked reset collector

`claude-reset` collects **read-only** Claude web grant balances into the Pi Orchestrator ledger. It does not redeem resets or make POST requests. The host owns the Kernel profiles, JSON map, schedule, and ledger; this repository owns the collector.

```json
{
  "anthropic": "kenan-personal",
  "anthropic-2": "limmy-google",
  "anthropic-3": "claude-works-kenan"
}
```

The keys are ledger account IDs and the values are names of **existing** Kernel profiles. Put the map in a host-owned JSON file (for example `/etc/nixos/pi-claude-resets.json`). Each ledger Anthropic account must have its Claude web email as its label. This label is an identity check, not a token.

```sh
claude-reset --config /etc/nixos/pi-claude-resets.json
claude-reset status --config /etc/nixos/pi-claude-resets.json --json
claude-reset --config /etc/nixos/pi-claude-resets.json --dry-run --account anthropic
```

Default `collect` starts each mapped profile with `kernel-browser start`, reads `GET /api/organizations`, `GET /api/account` (`email_address`), and `GET /api/organizations/{uuid}/usage?cedar_ember=1&skip_spend=1` with `kernel browsers curl`, then always stops its session. It accepts exactly one organization, verifies the account email against the ledger label, and totals unpaused, unexpired `cedar_ember.grants[*].resets_left`; `ends_at` supplies the nearest expiry. Only successful, identified responses update `Store.recordResetCredits(accountId,{at,available,nextExpiresAt})`. A failed read exits nonzero and retains the previous ledger reading. `status` reads the last-known balance without starting browsers; `--dry-run` makes the authenticated reads but does not write. `--json` emits per-account results. `--account ID` filters the map and is repeatable.

`CLAUDE_RESET_CONFIG` substitutes for `--config`; `PI_ORCHESTRATOR_LEDGER` overrides the default `/var/lib/pi-orchestrator/ledger.sqlite3`, and `PI_ORCHESTRATOR_STORE` overrides `/srv/pi/pi-orchestrator/dist/store.js`. The tool reads the deployed Store module, so deployment must provide that module and allow the invoking account to update the ledger. Kernel owns browser credentials; none are stored in the map or collector.
