# Human attention and error recovery

An internal failure is not automatically a request for the person's attention. The recovery owner decides what remains broken and who can change it. No client filters raw error strings to guess this.

- A background operation with an active automatic recovery path records diagnostics without adding a Machine error.
- Sustained loss of a useful feature may surface its consequence after a grace period, even while recovery continues. Peer listings and idle-notification projection use one minute; their previous snapshots remain available.
- When automatic recovery cannot proceed or its bounded attempts are exhausted, show the consequence and the available action. Do not substitute a provider exception or stack trace for that description.
- A failed explicit user action, unsafe state, authentication requirement or actual execution failure remains visible at its owner. A retry existing somewhere is not enough to make it harmless.
- Successful recovery clears the current attention item. Changing internal errors or retry IDs does not renew a dismissed warning about the same uninterrupted consequence.

[`server/error-feedback.ts`](../server/error-feedback.ts) owns `observeFailure`. Its typed input separates raw diagnostic `message` from human `impact` and `action`, and declares `recovery: automatic | required`. Automatic failures stay quiet unless their owner supplies an `attentionAfterMs` grace. Required recovery supplies an action. The existing `observeError` contract remains for errors whose owner already requires attention.

Remote's encrypted `supervisor.sqlite3` retains one `error_diagnostics` row per source: latest raw message/occurrence, recovery mode, first/last observation and resolution time. It is bounded by sources rather than attempts, and never sent in the owner-error feed. `error_feedback` stores only currently actionable feedback and durable dismissals. Resolving a diagnostic does not erase its evidence. Source-specific state such as naming receipts retains its own recovery schedule and attempt budget.

Thread naming and live connection behavior are specified in [state-machine](state-machine.md) and the [web contract](../web/README.md). Focused checks: `bun test apps/remote/server/error-feedback.test.ts apps/remote/server/thread-naming-worker.test.ts`.
