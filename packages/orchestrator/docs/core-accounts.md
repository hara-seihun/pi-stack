# External core accounts

`openCoreAccount` lets an external agent engine use the Orchestrator's Codex subscription accounts without taking over OAuth custody. The caller supplies its initial provider and model, PiStack session ID, and runtime environment. The returned account fixes one account alias and model for that engine process.

```ts
const account = await openCoreAccount({
  initialProvider,
  initialModel,
  sessionId,
  env,
});

const credentials = await account.credentials();
```

`credentials()` returns `accessToken`, `chatgptAccountId`, and `chatgptPlanType` when the credential carries a plan type. A Codex app-server client sends these values in its `account/login/start` JSON-RPC request over the child's stdin. It must not put them in arguments, environment variables, transcript events, diagnostic output, or the core's state directory. An unauthorized app-server request calls `credentials({ refresh: true, previousAccountId })`. The bridge compares and refreshes through `SharedOAuthAuth`, so concurrent Pi sessions, meters, and app servers still share one refresh lock and one credential file.

Interactive engines use the same eligible pool selection as interactive Pi. Disabled, cooling-down, voice-only, and reserved accounts are excluded. The bridge records `interactive:SESSION_ID` and heartbeats it every 30 seconds. A replacement process keeps the account from that active lease when it remains eligible. An assigned fleet process uses the run's recorded provider, model, account, and `run:RUN_ID` lease. The daemon owns that lease; the bridge neither heartbeats nor ends it. Assigned cores do not spend another admission or choose a replacement account.

`recordUsage()` accepts cumulative Codex thread counters. It records only positive deltas in the existing hourly usage table, split into fresh input, cache read, cache write, and output. The durable watermark covers the PiStack run or session and native thread across every account. Repeated notifications and resuming the native thread on another pool account do not double count usage; only new deltas go to the current account. Reasoning output remains part of output, matching the current Orchestrator usage contract.

`close()` aborts credential work, stops the interactive heartbeat, ends only the interactive lease created by this bridge, clears in-memory token and usage state, and closes the ledger. It is safe to call more than once. A provider failure or an app-server exit has an unknown request outcome, so the account bridge does not replay the request or move the session to another account.
