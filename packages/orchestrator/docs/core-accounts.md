# External core accounts

`openCoreAccount` lets an external agent engine use the Orchestrator's OpenAI Codex and Anthropic subscription accounts without taking over OAuth custody. The caller supplies its initial provider and model, PiStack session ID, and runtime environment. The returned account fixes one account alias and model for that engine process.

```ts
const account = await openCoreAccount({
  initialProvider,
  initialModel,
  sessionId,
  env,
});

const credentials = await account.credentials();
```

`credentials()` returns `accessToken`. OpenAI credentials also include `chatgptAccountId` and `chatgptPlanType` when the credential carries a plan type. Anthropic credentials do not require or invent a ChatGPT identity. The session-owned [Anthropic transport](codex-anthropic.md) consumes its token in memory. A Codex app-server client sends these values in its `account/login/start` JSON-RPC request over the child's stdin. It must not put them in arguments, environment variables, transcript events, diagnostic output, or the core's state directory. An unauthorized app-server request calls `credentials({ refresh: true, previousAccountId })`. The bridge compares and refreshes through `SharedOAuthAuth`, so concurrent Pi sessions, meters, and app servers still share one refresh lock and one credential file.

Interactive engines use the same eligible pool selection as interactive Pi. Disabled, cooling-down, voice-only, and reserved accounts are excluded. Account affinity lives in the ledger's `core-account:SESSION_ID` control record, independently of capacity. Opening an account or fetching credentials does not create or heartbeat a lease. A replacement process keeps that account when it remains eligible for the selected provider family, including after an idle period or clean close. An Anthropic core never inherits an OpenAI affinity, or vice versa. When opening a session with only an existing `interactive:SESSION_ID` lease, the bridge saves its account as affinity and ends that lease. One runtime owner opens a given session; reopening is not a way to share ownership with a live process.

`setActive(true)` synchronously creates `interactive:SESSION_ID` and starts its 30-second heartbeat. Repeated active calls preserve the interval's start time. `setActive(false)` ends the interval and stops the timer without changing affinity or credentials. The next active interval gets a new start time. The Store keeps the live lease ID stable and retains completed intervals under unique IDs in the same lease table, including when the account changes. Historical session-hour calculations therefore keep past exposure without counting idle gaps. If the pinned account became ineligible while idle, activation fails before dispatch; reopen the core to select an eligible account. The broker never changes credentials to another account inside a running engine process.

The Codex consumer acquires capacity before sending a turn or native compaction request. It keeps one reservation for the whole native tree while any root or descendant turn, compaction, dispatch, interrupt, or completion discovery is outstanding. Root completion and abort acceptance do not release capacity while a child is still active. Retained idle children, loaded history, account login, token refresh, and inspection alone do not reserve capacity. Twelve separately opened idle child cores add no reservations while their parent or a sibling remains active. Native children within one app-server share that app-server's reservation; separately opened cores each own their activity interval.

Explicit native rejection releases the dispatch reservation when the tree has no other work. A timeout or transport failure leaves an unknown outcome, so the consumer retains capacity until native lifecycle events establish completion or process-tree cleanup finishes. Completion arriving before the dispatch response cannot release the reservation while dispatch is still pending. An active turn restored from native history reserves capacity; completed history does not.

An assigned fleet process uses the run's recorded provider, model, account, and `run:RUN_ID` lease. The daemon owns that lease; `setActive` is a no-op and the bridge neither heartbeats nor ends it. Assigned cores do not spend another admission or choose a replacement account.

`recordUsage()` accepts cumulative Codex thread counters or Anthropic provider-response counters. Provider-response records carry `providerResponseId` instead of a native thread/turn pair. Anthropic records those counters directly because Codex drops usage on failed or incomplete responses; its native usage notifications do not also charge the account. It records only positive deltas in the existing hourly usage table, split into fresh input, cache read, cache write, and output. The durable watermark covers the PiStack run or session and native thread across every account. Repeated notifications and resuming the native thread on another pool account do not double count usage; only new deltas go to the current account. Reasoning output remains part of output, matching the current Orchestrator usage contract.

`close()` aborts credential work, stops the interactive heartbeat, ends only this session's interactive lease, clears in-memory token and usage state, and closes the ledger. The Codex consumer calls it only after the app-server's owned process tree has stopped. Failed process cleanup retains an active reservation. Durable account affinity remains after close. It is safe to call more than once. A provider failure or an app-server exit has an unknown request outcome, so the account bridge does not replay the request or move the session to another account.
