# Per-person usage dollars

`pi-user-usage` reads one person's Pi Remote conversation logs and reports tokens, logged API value, and estimated subscription-equivalent dollars. It defaults to a $200 plan and a 30-day month.

```bash
pi-user-usage alex
pi-user-usage alex --since 7d
pi-user-usage alex --since 2026-09-01 --until 2026-09-06 --plan-usd 200
pi-user-usage alex --json
pi-user-usage alex --accounts openai-codex,openai-codex-1
```

Omit the name to read your own usage. These are Unix person names from Pi Remote's registry, not provider account aliases. Reports cover the current host only. `--since` accepts an ISO date, a timestamp with a timezone, or a lookback such as `24h`, `7d`, or `2w`. `--until` is exclusive and defaults to the instant the command starts.

## What the figures mean

- **Tokens** are the sum of fresh input, output, cache reads, and cache writes. Output already includes reasoning. Reasoning is never added a second time.
- **Logged API value** is the sum of the response logs' `usage.cost.total`. It is not a provider invoice, a current retail quote, or an extra subscription charge. Missing or all-zero prices are reported as unpriced rather than free.
- **Subscription equivalent** is a prorated estimate of capacity consumed, priced at `--plan-usd`. It does not count how many subscriptions were purchased.

The estimate uses the Orchestrator's latest 24 hours of token and quota evidence. For each model, it finds shared accounts whose matching-model tokens occupy at least 99.9% of the sampled meter's traffic. Voice-reserved accounts are excluded. Tiny other-model traffic, such as thread naming, is ignored below that threshold. Unknown or materially mixed models make a sample unusable.

Each sample matches quota readings to whole-hour token buckets within five minutes. It must span at least three hours in one uninterrupted reset window, consume at least five percentage points, end below saturation, and have a final reading no more than two hours old. At least two accounts and ten pooled percentage points are required. Accounts are pooled before division, so a flat or noisy individual meter cannot dominate the result.

Calibration weights each token component with this person's average logged price for that model and component. It requires prices for every component seen in the sample. No rates, token allowances, or dollar multipliers are hard-coded.

For a weekly meter:

```text
API value per plan-month = sample API value / sample quota points × 100 × month-days / 7
person's plan-months = person's logged API value / API value per plan-month
subscription dollars = person's plan-months × plan-usd
```

The human-readable report also shows raw tokens per month at the **sampled** workload mix. That is not a fixed vendor token allowance. Each provider's overlapping weekly and model-scoped buckets are combined by taking the largest total fraction, not by adding overlapping charges. Different providers' dollar estimates are added. If any required model lacks usable evidence, the total is unavailable and the report shows any known subtotal separately.

All sampled accounts must have comparable subscriptions and all their traffic must reach this host's ledger. Use `--accounts` to restrict calibration to accounts known to meet those conditions. Historical usage is valued against recent capacity, not a reconstruction of past plan limits. Price-weighted quota is an empirical assumption. Priority mode, long-context pricing, provider policy changes, and five-hour burst limits can change the result. JSON includes every sample, excluded account, assumption, and the observed account-capacity range. That range is not a statistical confidence interval.

## Scope and private folders

The command discovers `PI_REMOTE_DATA` and the ledger path from `/var/lib/pi-remote/persons/USER.json`. `PI_REMOTE_PERSONS_DIR` overrides the registry location. It recursively scans the person's `sessions/` directory, including retained forks and abandoned branches, because those calls consumed tokens too. Copied entries are deduplicated by their entry id, timestamp, and complete message, including usage. A branch switch does not erase spending.

If an encrypted folder is not visible in the caller's namespace, the command enters the running `pi-remote@USER` mount namespace and executes the scanner as that user through passwordless `sudo`. It sends the self-contained scanner over stdin, so the other person does not need access to the caller's checkout. The configured ledger is also read as the selected person, in her namespace when encrypted. A shared ledger can still be reached through a private per-person symlink. An explicit `--ledger` override is read as the caller. Running as root alone cannot read an owner-only FUSE mount. A locked person gets an explicit unlock-required error. The command never retrieves a key, unlocks anyone, starts services, reads credential files, or writes databases.

Only usage persisted in conversation JSONL is counted. Unsaved naming and compaction calls, voice, fleet jobs, deleted sessions, and responses without recorded usage are not recoverable from these files. The report names that scope rather than claiming to measure every activity by a person. A partially written final line is reported and excluded. Malformed completed lines fail the scan instead of silently losing spend. Logs are streamed one file at a time; no transcript text is printed or persisted.

## Evidence and operations

[`pi-orchestrator usage-evidence`](../../packages/orchestrator/README.md#usage-evidence) exports a read-only, transaction-consistent snapshot. The tool consumes this public command, not private table queries or provider endpoints. No model request or network quota poll is made.

For a reproducible calculation against a chosen directory:

```bash
pi-orchestrator usage-evidence > /tmp/usage-evidence.json
pi-user-usage --sessions /path/to/sessions --evidence /tmp/usage-evidence.json --json
node --test tools/user-usage/usage.test.mjs
```

`--ledger FILE` selects the evidence ledger when not using a saved snapshot. `--month-days` changes the normalization period. Evidence files contain account aliases and token aggregates but no credentials, labels, run ids, or transcripts. Keep exported reports in private operational storage and delete them when no longer needed. The tool creates no persistent state of its own.

`config/tools.json` declares the command; `deploy/tools` installs it for every Pi account. The root test gate runs its synthetic accounting tests. Its only dependencies are Node, the deployed `pi-orchestrator`, and the host's existing `sudo`, `systemctl`, and `nsenter` for cross-person reads.
