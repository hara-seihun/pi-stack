# Browser runtime

This entrypoint loads upstream `pi-agent-browser-native` and selects the matching dependency tree's `.bin` on the Pi process's `PATH`. Both package versions are pinned in the [stack manifest](../../../../package.json) and installed together by `deploy/runtime`. Immutable executable `browser-controlled-tabs-policy-20261008-glibc235` comes from Hara's fork source `3dbf5de5a86fcdf786c33c7968920def74b623f8`, with SHA-256 `b417076c8f79c853acb1a871569d8f5d3ba15ccdcb2e1a338d01c9f75e3b17cf`. The immutable Hara executable package retains upstream-derived download-scope, screenshot target-wake, cross-origin frame lookup/evaluation/console repairs, and native controlled-date fill. Temporal fill uses the input realm's native value setter before input/change events so framework value trackers observe the edit. Invalid, non-editable, detached or application-rejected temporal inputs fail with typed codes rather than reporting success. Retention is checked after a bounded rendering opportunity. Frame repairs derive from [upstream PR 1697](https://github.com/vercel-labs/agent-browser/pull/1697), commits `85c89006` and `c4cabb4e`, with their author retained in the fork.

It resolves physical paths before registering the tool. Changing `/srv/pi/runtime` or `~/.local/bin/agent-browser` during a turn cannot change that process's browser executable or native module. Interactive Pi, Pi Remote and embedded fleet sessions all load this entrypoint through the configured package list. A new or reloaded session selects a new pair together, including a recovered worker whose Orchestrator code is from an earlier release. Pi's [extension loader patch](../../../../vendor/pi/README.md) resolves the selected physical entrypoint before import. Clearing Pi's factory cache alone does not clear Node's native ESM symlink cache.

Shared runners host several Pi sessions on one dependency generation. An SDK application needing simultaneous sessions on different dependency generations must give them separate processes because executable resolution uses the process environment.

## Durable runner browser resources

On Linux durable runners, `PI_THREAD_RESOURCE_BOUNDARY` selects the release-owned [`bin/agent-browser`](bin/agent-browser) ahead of the pinned dependency bin. The entrypoint retains that physical upstream executable in the child environment, not a mutable runtime symlink. The launcher creates a foreground systemd scope under the runner's existing tooling slice, with `BindsTo`/`After` its controller service and `OOMPolicy=kill`. Its CLI, daemon and Chromium descendants inherit the caller's UID, mount namespace, cwd, argv and stdin. They share the existing 3 GiB tooling budget with bash; the controller stays in its sibling 4 GiB cgroup under the unchanged 8 GiB aggregate. No second browser runtime or manager-spawned service is introduced.

A successful CLI exit does **not** stop this scope: its daemon/Chrome descendants remain for later native calls, under the upstream session cleanup/idle contract. Closing the browser collects its now-empty scope; controller exit kills remaining scopes. Attached remote/CDP browsers were not spawned by this scope and are not moved or killed. Non-durable supervisors and non-Linux callers retain the unwrapped executable. The browser script permission worker and unrelated extension subprocesses retain their existing controller boundary.

This is cgroup isolation, not a promise about which process the OOM killer might prefer. The controller inherits the host's OOM score policy; the launcher raises its own score before executing upstream. Ordinary Unix user managers cannot rely on a negative controller score without additional privilege, and a protected parent's negative score is inherited by children unless reset. The follow-up was required after native browser trees reached about 3 GiB while the shared controller itself used about 1 GiB: bash-only isolation would have left them competing inside the new controller ceiling.

`packages/orchestrator/tests/runner-browser-budget.test.ts` uses the actual native tool and two real Chromium trees on a static loopback fixture. It verifies browser UID/mount continuity, every Chrome PID in the tooling subtree, only Node in the controller cgroup, then forces a tooling-cgroup OOM and checks that twenty accepted native sessions still respond and settle once under the same PID. This is a browser-descendant/custody regression, not twenty production model contexts or producer completion. It skips explicitly without a user manager, native CLI or installed Chromium; `PI_TEST_CHROME_EXECUTABLE` may select a test binary without loading a personal browser profile.

The native commands, session state, cleanup and browser configuration remain upstream-owned. The entrypoint adds the canonical external-action fence described below. The matched executable owns sensitive-form output protection; the release installer adds its policy to the native tool description and installed README/command/contract docs. Browser profiles and credentials stay in their existing locations outside the release.

## Canonical external-action fence

[`effects.mjs`](effects.mjs) wraps the registered native tool's executor **in place**, including its recursive script calls. Declared effects cross the existing [canonical action authority](../../../kenan-memory/src/actions.ts) through the asynchronous Node HTTP client; they never open another SQLite journal or block the supervisor event loop. Submit reserves the stable purpose/recipient contact, claim acquires its generation, and dispatch commits the one-shot fence before entering native execution. A changed tool-call UUID, replacement thread or reworded purpose cannot clear an unresolved recipient contact. The authority authenticates and routes the owner across hosts; the browser owns no independent manager selection.

Use one `args` or `semanticAction` operation, with this additional top-level field:

```json
{
  "semanticAction": { "action": "click", "locator": "text", "value": "Send" },
  "externalAction": {
    "intentKey": "booking:stable-business-purpose",
    "recipients": ["mailto:actual-recipient@example.invalid"]
  }
}
```

Declared batch/job/script effects are refused before reservation: split the effect into its own call. Payload identity hashes the complete native input (without the declaration); plaintext form/credential contents are not copied into the action journal. A payload mismatch is an error, not a new dispatch. An exact retry returns the existing canonical status without repeating the native call. A changed purpose targeting a held recipient returns a `fenced` refusal with `isError: true` and the existing action, including when that action succeeded; its receipt is not success for the changed request. Dispatch/finish response loss, abort, timeout and even successful native gestures remain non-replayable: the browser marks the effect **uncertain**, because a gesture receipt cannot prove provider acceptance or rejection. Inspect the actual provider and reconcile the existing action through `action_inspect`/`action_reconcile` before another contact.

Without a declaration, the wrapper refuses narrowly classifiable effect-prone commands: `chat`, `confirm`, WebMCP `invoke`/`result`/`cancel`, and `find ... click`/semantic click targets whose exact label matches the fence's send, submit, order, buy, pay, purchase, delete-account, transfer, publish, post or unsubscribe label set. Classification uses the matched native argv parser, batch precedence and semantic/job compilers; flagged commands, stdin/raw batches and recursive script commands share that path. Ordinary navigation, snapshots/getters and unclassified interactions remain available without consulting the authority.

**Boundary:** this enforces entry to a declared/classified native invocation, not arbitrary website semantics or every HTTP request. CSS/ref clicks without a classified label, alternate/localized labels, fill/check/select/keypress autosubmission, eval/DOM code, script-generated opaque operations, GET/navigation side effects, page timers/workers/popups, profile startup/extensions, Electron and raw CLI/CDP/provider calls outside this registered tool are not universally classified or fenced. A single page gesture can itself initiate multiple requests. There is no claim of universal browser effect prevention or provider exactly-once delivery; declare known effects rather than treating an unclassified interaction as read-only proof.

[`effects.test.mjs`](effects.test.mjs) uses the real canonical ActionStore behind a disposable loopback HTTP authority, with synthetic provider counters. It checks concurrent workers, new IDs, rephrased intent, payload conflict, succeeded-action exact dedup and changed-request refusal, lost dispatch/finish receipts, post-effect exceptions, ordinary reads without authority calls, classified batch/job inputs and aggregate refusal. Its actual native Chromium probe clicks a synthetic Send button once, confirms its synthetic provider receipt, dedups an exact retry, refuses changed intent/payload, undeclared Send and a classified script inner call, then closes the browser. It never uses live recipients, accounts, purchases or signed-in profiles.

## Sensitive form outputs

Native snapshot/value/text/HTML observations redact card numbers, expiry/month/year, CVC/CVV/security code, passwords and one-time codes, including cross-origin iframes and shadow roots. Markers carry their classification (`[redacted: cc-number]`, `[redacted: password]`, etc.). Cardholder names (`cc-name`) stay readable. Observation does not clear or change live form values.

Evaluation and screenshot/PDF on tabs with detected sensitive controls or known sensitive state return `SENSITIVE_OUTPUT_UNSUPPORTED` before execution or artifact creation. Ordinary evaluation and captures on non-sensitive tabs remain supported. Continuous recording/tracing/profiling/HAR/streaming, inspect/expose and init-script routes are refused because a one-time inspection cannot protect future fills. Sensitive tabs also refuse state export, downloads, raw network/console/clipboard/storage observations and other unstructured page-data routes; use safe snapshots and typed getters. Saved native-wrapper `outputPath` results inherit the protected response. This is a DOM form-output boundary, not a general scanner for caller arguments, arbitrary page-owned data or downloads. Secret entry belongs to the private credential-fill transport, not plaintext tool arguments.

## Private credential fill

Use `privateCredential` as the tool's only input mode after selecting the intended tab and frame. Its arguments are references, never secret values:

```json
{
  "privateCredential": {
    "provider": "proton-pass",
    "item": "Exact authorized vault item title",
    "field": "number",
    "selector": "input[autocomplete=cc-number]",
    "target": "exact-active-CDP-targetId",
    "frame": "exact-selected-frameId"
  },
  "timeoutMs": 240000
}
```

Use `frame: "main"` for a top-level field. The selected native frame's identity must be explicit; a CSS selector naming an iframe is not its frame ID. Private fill accepts CSS selectors, not snapshot `@refs`. Supported fields are `username`, `email`, `password`, fresh `totp`, `cardholder_name`, `number`, `verification_number`, `expiration_date`, `passport_number` and `phone_number`. Optional `format: "mm/yy"` converts only an expiration date inside the credential plugin; absent or `raw` preserves the vault value (`raw` compiles to an omitted native format flag). Card entry requires an authorized purchase; this operation fills one field and never submits.

[`private-credential.mjs`](private-credential.mjs) validates and compiles this mode into one native `auth fill --credential-provider PROVIDER --item TITLE --field FIELD --selector SELECTOR --target TARGET --frame FRAME [--format FORMAT]` call. Raw args support the same command. It rejects plaintext/value fields, conflicting input modes, stdin and fresh-session launches. No helper process or raw socket bypass is introduced: native wrapper session/restore-policy coordination and the existing external-action fence remain in the call path. A supplied `externalAction` is preserved and fenced exactly as the equivalent raw args invocation, including uncertain-outcome deduplication.

The matched native executable must implement `auth fill`; an older executable returns an error, never an alternate credential path. Native owns the one-deadline plugin lookup and fill under its session lock, exact active target/selected frame checks before and after lookup, and metadata-only success/error output. Plugin protocol `credential.field.resolve` uses capability `credential.read` and request `{itemRef,field,format?,timeoutMs}`; its `{value}` response travels only over the private plugin pipe. The machine Proton plugin is separately owned by `/home/kenan/tools/agent-browser-pass-cli`, configured through the person's own `AGENT_BROWSER_PLUGINS`; unconfigured people do not acquire administrator vault access. No credential value enters tool args, native CLI argv, saved tool output or action payloads. A lost fill receipt is an unknown outcome, not permission to retry.

The focused wrapper tests use synthetic references and a disposable authority; the machine plugin fixture uses synthetic secrets without reading Proton or a live browser.

## Authorized clean-tab restoration

Generic browser state saves cookies/local storage, not tab-scoped session storage. To carry an authorized clean tab across worker replacement, use `state save-tab PATH ACCOUNT ORIGIN TTL_SECONDS`, then on a new `about:blank` tab use `state load-tab PATH ACCOUNT ORIGIN` before `open URL`. The capsule is owner-private, expiring and bound to the Unix owner, person context, explicit account and exact origin. Restoration installs that selected tab's session storage before application startup, only at the authorized origin. Each additional tab needs its own explicit load; nothing replays credentials globally.

This capsule does not replay context-wide cookies or local storage: their scoping differs from exact-origin tab state. Use the separate generic state mechanism only with its own authorization. Missing, expired or mismatched authorization and sensitive/guarded tabs produce errors, not guessed authentication or cleared sensitivity. Successful output is metadata only; capsule contents remain private.

The doctor uses synthetic loopback authorization and verifies startup in replacement browser owners and new tabs, account/origin mismatch refusal and private file permissions. It never acquires a live credential, replays a personal benchmark or substitutes a guarded tab for a clean one.

## Batch timeout custody

The native CLI buffers JSON batch results until all steps finish. A timeout with no returned step receipts therefore does not prove that no actions ran. Unobserved outcomes remain `unknown`; they are not labeled `failed` or `pending`, and the wrapper does not select a supposedly first incomplete mutation for retry. Observe the application before continuing a timed-out mutating flow.

`patch-browser-batch-timeout.mjs` binds wrapper0.6.6 source and compiled output hashes. On POSIX the wrapper starts its command launcher in a separate process group and hard-stops that group on timeout or abort, including the npm JavaScript launcher's native CLI descendants. Detached browser daemons and externally attached browsers remain outside that group. An already-dispatched daemon operation may still settle, but the stopped CLI cannot dispatch subsequent batch steps. Windows keeps its existing process-tree termination route. Focused tests prove timeout/abort descendant retirement, detached-daemon preservation, honest unknown outcomes and source-guard atomicity. An isolated delayed-CDP fixture proves that a fill beyond an interrupted wait runs before repair and does not run after it; normal args batches and structured jobs still fill both fields.

## Managed lifecycle

The release applies a version-matched wrapper0.6.6 repair from upstream source `fe59ce7e5e4b2f4ba3312a1d4ac3b42fa5fe2cb9`. Explicit close, replacement cleanup and shutdown send close without first waiting for session metadata from an unresponsive daemon. Normal reuse retains fail-closed restore-policy validation. The native daemon now serves recorded session metadata without CDP/restore mutation; lifecycle calls return explicit `daemon_busy` when another operation owns the daemon rather than waiting or inventing a stale matching state. The JSON CLI preserves native failure envelopes and codes. The wrapper retries only typed `daemon_busy` metadata failures within a one-second local deadline; persistent busy is an explicit refusal, not stale matching policy or cancellation. Background CDP maintenance does not block the accept loop. Close autosave and owned-browser close are bounded at two seconds each; externally attached browsers detach only. Restore ownership is retired only after a structurally valid native success confirms `closed:true`; exit zero, malformed JSON or a confirmation prompt cannot silently discard custody. `patch-browser-managed-close.mjs` checks both the original and compiled-patch SHA-256 and fails explicitly on unknown source.

The doctor additionally gates release on a populated disposable cross-origin sensitive fixture: snapshot and getters, cardholder-name preservation, saved wrapper output, encoded-value eval refusal, and screenshot/PDF refusal without residual files. Its synthetic card values are test numbers, never live credentials.

The native tool documentation lives under `/srv/pi/runtime/node_modules/pi-agent-browser-native`. The stack owns the normal `pi-agent-browser-doctor` command. Upstream's doctor only recognizes its own package paths and recommends an npm installation when it sees this entrypoint. That advice would recreate mutable package state, so the stack's doctor checks actual Pi registration and the native tool instead.

The release-switch tests cover a continuing process, a fresh process, SDK reload, and bundled RPC reload through a configured package path. Both reload tests switch forward and roll back. The executable fixtures distinguish versions without needing Chromium in CI.

[`browser-doctor.mjs`](../../browser-doctor.mjs) loads the deployed native tool through normal settings, rejects missing or duplicate registrations, opens a loopback page, takes an interactive snapshot, checks its title, saves and verifies a PNG screenshot, fills and reads back inputs in static and dynamically injected cross-origin iframes selected by CSS, verifies that `eval` runs in the selected frame, fills real React-controlled date and datetime-local inputs through direct selectors, `find label` and semantic actions, checks retained DOM values and shared-object application state, and verifies isolated-browser cleanup. The top page uses `127.0.0.1`, while its child uses `localhost`; no public payment service is contacted. A second disposable native session attaches over CDP after the iframe already exists, then snapshots, fills and reads its child realm. This covers remote attachment's initial event handoff, not merely iframe creation after local launch. The attached session disconnects first and its owning probe browser closes in `finally`. It makes no model request and uses no signed-in profile. The native version guard remains in force. Deployment installs the doctor into the immutable dependency tree, includes its source in the tree's identity, and runs it before service activation. It can also prove recovery using a recorded worker release and a copy of a settled session's JSONL. See [deployment and recovery](../../../../docs/deployment.md#browser-recovery).
