# Preferred Opus capacity fallback
Hara authorized 2026-10-11: when all Anthropic accounts are exhausted, continue Kenan Opus 5.5 work on Sol 6.1; return to Opus as soon as its pool becomes eligible.

Installed source owner: /home/kenan/machine/ubuntu-apps/opus-capacity-fallback.
Regular native sessions discover extensions/opus-capacity-fallback.js, linked to index.mjs. The extension uses existing account-selection/auth evidence and changes models at an awaited model-call boundary, without aborting a streaming answer or manufacturing quota. Existing routing still owns credential custody, account entitlement, leases and usage.
The kenan-opus-fallback.service reconciles dormant accepted work every five seconds through the existing own-UID Core gateway. It saves preferred-model attribution, updates settings, and uses source-owned retryWaiting for the original execution; it never sends a new human message. Isolated dormant contexts receive the same extension without adding tools. Fleet-assigned runs and raw contexts keep their separate execution policies.
State is /var/lib/pi-stack/opus-fallback/state.json, owned by Kenan, containing thread IDs and preferred-model metadata only. An explicit selection outside Opus/Sol relinquishes policy for that thread.
No test prompts, forced quota exhaustion, or test suites were run.

Ledger bug: Core process HOME is root while scope HOME is Kenan. defaultLedgerPath must honor its supplied environment HOME. Installed remote:kenan explicitly names the existing /home/kenan/.local/share/pi-orchestrator ledger/auth symlinks, preserving original shared state.

Reload exposed deleted binary-5090 clone entries in remote/fleet resources; those two obsolete entries were removed, without creating replacement content or changing private storage. Retired standalone brokers had reappeared on Core-owned ports; both now have persistent ConditionPathExists=!/etc/pi-stack/core.json, Restart=no, KillMode=process, TimeoutStopSec=infinity in zzzz-core-owner.conf. Normal stops preserved provider ledgers.
