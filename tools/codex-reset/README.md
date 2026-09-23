# codex-reset

`codex-reset` spends OpenAI's banked rate-limit resets across the Codex accounts in the orchestrator pool. A redemption sets an account's weekly meter back to 0% and restarts the seven-day window from its next use.

Credentials come from the orchestrator's shared store beside its ledger — `/var/lib/pi-orchestrator/auth.json` where a system service owns the state, `~/.local/share/pi-orchestrator/auth.json` where a user service does — and are read without refreshing, because Codex refresh tokens are single-use and an independent refresh would revoke the family under running sessions. Accounts are the `openai-codex*` OAuth entries in that file, the same pool the orchestrator routes sessions across.

```bash
codex-reset                 # or: codex-reset status
codex-reset redeem --dry-run
codex-reset redeem
codex-reset redeem --account openai-codex-9 --min-used 90
codex-reset status --json
```

## What it does

`status` reads `GET /backend-api/codex/usage` and `GET /backend-api/wham/rate-limit-reset-credits` for each account and prints the weekly meter, any five-hour meter, banked resets, and the access token's remaining life.

`redeem` spends **at most one credit per account per invocation**, oldest-expiring credit first, and only on accounts whose weekly meter is at or above `--min-used` (default 100). Unspent allowance is discarded by a reset rather than banked, so redeeming below 100% throws away whatever was left; `--min-used` exists for the deliberate cases, not for routine use.

After a redemption the tool waits for `codex/usage` to report the drop — the endpoint serves the pre-reset percent for up to a minute — then writes the fresh reading into `/var/lib/pi-orchestrator/ledger.sqlite3` and clears the account's cooldown, so the orchestrator admits work against the new allowance without waiting for its next sampler pass.

Redemption also records the remaining banked-reset balance in the ledger. The Codex sampler reads that balance on every pass, so `status` is no longer the only way to see it; Pi Remote's System tab shows it for each account.

Exit status is non-zero when any account's redemption failed. Skips are not failures.

## Notes

- Credits replenish from OpenAI's grants and referral promotions; nothing here creates them. When an account shows zero banked resets it is simply out.
- Anthropic has no equivalent, so those accounts are untouched.
- `PI_ORCHESTRATOR_AUTH`, `PI_ORCHESTRATOR_LEDGER`, and `PI_ORCHESTRATOR_STORE` override the credential store, ledger, and orchestrator store module for testing.
- Background on reset cadence and how the calibrator paces spend against it: [`openai-reset-statistics.md`](../../packages/orchestrator/docs/openai-reset-statistics.md).
