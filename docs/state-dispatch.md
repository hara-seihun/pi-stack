# Explicit app states

Hara's October 6, 2026 requirement: the app must describe every state. No catch-all dispatch may disguise an unspecified state as another state or silently discard it.

## Implementation contract

- Closed lifecycle, activity, event, outcome and command domains use literal unions, enums or exhaustive records. Every valid member has named behavior, including deliberately non-presentational events.
- A switch enumerates cases without a `default` clause. TypeScript handlers use a post-switch `never` assertion when necessary; Java enum switch expressions are exhaustive. Adding a state must require deciding its behavior, not route it to a generic branch.
- Equivalent `if`/`else` dispatch must obey the same contract. Renaming `default` to `else`, `other`, `unknown` or a valid status is not a repair.
- Wire, database and native boundaries validate discriminators. Invalid values produce a protocol or status-reporting error naming the defect. They never become idle, successful, generic working, an unrelated command, or an apparently known connection state.
- Open-ended external data is not a closed lifecycle. Its supported/unsupported outcome is explicit and retains useful evidence. Unknown MIME data may be a binary file; unknown execution phases may not be idle. Provider/model identifiers remain open data, not enumerated app states.
- A field's intentional omitted-value setting, a module's default export and third-party vendor code are not switch catch-alls. Do not remove them mechanically.

[Thread dependency waits](threads.md#durable-dependency-waits-and-own-thread-wakes) name agents, jobs, deployments or collaborator messages. Being available for another assignment is idle. Existing untyped waits preserve custody but show the missing-type reporting defect rather than inventing a classification.

## Regression gate

`node scripts/check-state-dispatch.mjs` rejects switch default clauses in first-party JavaScript/TypeScript, Java and C/C++ under `apps` and `packages`. `npm run check` includes it and its scanner tests. The gate excludes generated output, dependencies, third-party vendor assets and tests. It is a syntax guard, not a proof of all state semantics; typed exhaustiveness and focused invalid-input/transition tests own that proof.

The compiler checks closed-domain dispatch, while focused protocol tests check unknown/missing values and intentionally ignored known events. Never weaken a validator just to make a fixture with invented states pass; update the fixture to represent an actual supported state.
