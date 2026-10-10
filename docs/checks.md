# Change-relevant checks

## Delivery policy

Publication ships the submitted exact SHA; later `main` cannot replace or requalify an in-flight candidate. kenan-server builds and deploys with service-start recovery only, running zero tests, doctors, qualification, warm-up or browser gates in its delivery path. Converge independently runs the minimal builds/tests relevant to changed source and a host health check. Its results cannot delay or roll back kenan-server. Tests, proofs and doctors outside that minimal remote lane run after serving; receipts report passed, failed, pending or not run truthfully, separately from host delivery. Neither a complete check graph nor a fleet-wide green result is required before local serving.

## Check graph and reuse

`npm run check` owns the application check graph. `scripts/test.mjs` exports `checkJobs`; `scripts/check-plan.mjs` owns source coverage, workspace export/import resolution and generated-product declarations. The pool in `scripts/run-jobs.mjs` retains typed prerequisites and the shared concurrency budget.

Without `PI_STACK_CHECK_CACHE_DIR`, every check executes. With an absolute persistent directory outside the checkout, successful stages can be reused:

```sh
PI_STACK_CHECK_CACHE_DIR=/absolute/persistent/check-cache npm run check
PI_STACK_CHECK_CACHE_DIR=/absolute/persistent/check-cache node scripts/test.mjs --plan
```

The JSON plan gives each check's content key, inputs, source/import closure, coverage, product declarations and custody state: `reusable`, `needs-execution`, `needs-output-repair`, `requires-cold-proof` or `always-run`. A receipt's existence alone is not a reusable verdict. Unknown job names reject before execution.

## What a verdict owns

A key includes the command/arguments, working directory, declared and observed environment inputs, exact first-party file contents/modes, package lock, checker implementation, executable contents/versions, and installed dependency contents. Content indexes use inode/device, mode, size and nanosecond modification/change times to avoid rereading unchanged dependency bytes; directory membership is rescanned. Dependency mutations invalidate verdicts even when the advertised package version is unchanged.

First-party imports follow workspace exports and JavaScript-to-TypeScript source resolution. Literal file dependencies are included alongside imports. Declarative filesystem scopes cover shell deployment fixtures, generated-module fixtures and whole-program typechecks; these scopes are source contracts, not a repository-wide release revision. Unrecognized computed imports require a visible `full-source-proof`, including every current source file and additions/deletions, rather than receiving a narrow green verdict. Such unknown-coverage stages execute fresh on every invocation and never save a reusable pass receipt. Adding a new kind of filesystem/subprocess fixture requires declaring its source footprint in `check-plan.mjs`.

Each Orchestrator, Runtime, memory, root and Remote test file gets its own verdict. Orchestrator suites still depend on the whole-workspace typecheck and the two dependency reconciliation stages. Remote suites retain generated package preparation, the shared RPC prerequisite and the compiled frontend prerequisite. Node deployment checks retain the separate guest-enabled/disabled activation matrices. Historical log markers cannot seed this contract: they do not establish its input, toolchain and product custody.

Product stages reuse only when both their input key and current product content manifest match. Missing or corrupted outputs execute the stage again. `Remote build` always invokes `build-workspace.mjs`: that owner reuses unchanged compiled output and cheaply binds exact release metadata. Kenan then copies that built Remote output, without another Vite invocation. Remote tests no longer run the workspace's build a second time.

## Receipt custody

Only passed stages produce candidates. A failed sibling does not discard an unchanged passed stage. Input mutation during a stage or absent declared products produces an explicit failed result.

At the end of an executed check graph, `checkExecutor.finalize()` rechecks source and toolchain custody and flushes matching successful candidates atomically. Mutated source, toolchain or products produce a typed non-validated result; `test.mjs` sets a failing exit code and owns this finalization even when a sibling fails. A caller using `checkExecutor` directly must call `finalize()` and handle its returned state. Tests may explicitly provide a synthetic `versions` identity to exercise receipts in isolated fixtures. These verdicts establish only the checks actually run; they do not qualify kenan-server delivery.

## Bounded contracts and measurements

```sh
node --test scripts/check-cache.test.mjs scripts/check-plan.test.mjs scripts/run-jobs.test.mjs scripts/orchestrator-check.test.mjs
```

The contracts cover import/exports closure, unrelated-source reuse, newly imported/untracked files, source/toolchain mutation, output corruption/removal, corrupt receipts, complete test inventory and prerequisite/budget preservation.

On kenan-server, four real shipping checks (continuation, usage, prompt availability and mail boundary) executed cold in 1.20 seconds and reused in 0.10 seconds, excluding toolchain custody scans. Toolchain identification measured 1.48 seconds cold and 0.60 seconds warm. An isolated fixture running the real usage/mail contracts measured 448 ms cold, 12 ms warm and 180 ms after changing the mail source; only mail reran. The full 424-check key/coverage plan measured 2.64 seconds warm. These are planning and bounded-subset timings, not a claimed full-repository cold or warm execution. The publication owner records host delivery timings separately from the scope, timings and outcomes of checks actually run.
