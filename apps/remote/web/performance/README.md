# Browser client timing

A metadata-only timing recorder for the actual browser client talking to live services. It does not mock APIs, read response bodies, persist page text, export auth, or run another browser automation transport.

Use the native `agent_browser` tool. Load authorized private auth state through its `state load PATH` operation without reading the file. Open a **new tab** on the authorized frontend, inspect the navigation once, then install the recorder. Sensitive protection is sticky per tab: this harness never circumvents it, unmounts secret forms or alters authentication. A sensitive-output refusal means this tab cannot be used for evaluation.

## Native-tool entrypoints

```sh
node apps/remote/web/performance/matrix.mjs install /private/path/install-tool.json
node apps/remote/web/performance/matrix.mjs matrix /private/path/config.json /private/path/matrix-tool.json
```

Read the generated JSON and pass it to `agent_browser` as one tool input. `install` uses native `eval --stdin`; `matrix` uses native `batch --bail`, actual native clicks, and page-target verification around evaluations. The CLI does not run browser shell commands. Keep configuration, authenticated state and measurements outside the repository.

An explicit matrix configuration:

```json
{
  "cache": "warm-remount",
  "rounds": 2,
  "names": ["chats-nav", "agents-nav", "attention-nav", "files-nav", "machine-nav"],
  "quietMs": 120,
  "timeoutMs": 12000,
  "toolTimeoutMs": 50000,
  "outputPath": "/private/path/measurements.json"
}
```

The Machine case waits for loaded governor controls, not merely `.machine-screen`. Use an individual shell-only spec when measuring its module/render separately; an unavailable data predicate is missing coverage, not an instant load.

Start on a different destination from the first case. Cold-module samples require a new document; repeated tab remounts in one document are warm-module samples, not cold ones. Browser HTTP cache, app data cache and server caches are distinct. Record which is cold; do not claim every layer was flushed. Idle module preparation on a candidate is part of its normal first-visit behavior, not an excuse to force-remove that preparation.

## Individual actions

`piClientTiming.arm(spec)` returns `{ok:true}` or an explicit error. Then click/fill through the native tool and call `piClientTiming.take()` for the completed record. `arm` does not perform the action. Specs require every field:

```js
piClientTiming.arm({
  name: "tool-expand",
  cache: "cold-body",
  trigger: "[data-perf=tool]",
  scope: ".pane-detail",
  ready: ".tool-step[open] .step-result",
  absent: ".tool-step[open] .step-loading",
  loading: null,
  quietMs: 120,
  timeoutMs: 12000,
})
```

Use known synthetic fixtures for transcript/body expansion, search, settings and writes. A selector can be tagged by an opaque index without copying its text. `ready` identifies the usable destination; `absent` excludes visible loading controls. `loading` can be `{selector, texts}` for exact, public loading labels without a dedicated attribute. Closed `<details>` descendants do not count as visible. Do not use an existing shell as a proxy for loaded data. A deep-linked empty queue is route-render coverage, not native queue-chip coverage.

The recorder owns observers, timers and its fetch wrapper. `dispose()` releases them; disposing an untriggered arm is explicit. Reinstall after full-document navigation. Evaluation and `get url` commands are observation overhead and are outside measured input-to-frame timestamps.

## Record meaning

- Input begins at the actual **pointerdown** event, including client intent prefetch; keyboard/programmatic activation uses click, fills use input. `triggerEvent` names the observed event.
- `firstRenderMs` is the first animation-frame callback after an observed DOM mutation. It measures the first rendered response, including a loading shell, not pixel capture or final data readiness.
- `usableMs` is the first frame satisfying the explicit ready/absence predicate. It is separate from first-render and can precede background refresh completion.
- `settledMs` requires usability plus the configured DOM/resource quiet interval and no still-pending fetch started within the action. It includes the quiet interval. A timeout has `state:"settle-timeout"` and `settledMs:null`, never fabricated success.
- Resource entries contain templated routes, status, transfer/body sizes, first-byte and body durations. Query strings, credentials, unknown path segments and external hosts are omitted. Fetch observations include method and header completion/pending state. No body is cloned or consumed.
- Frame gaps, event delay/processing, longtasks and long-animation-frame script/blocking duration are separate costs. Script duration covers supported long-animation-frame entries, not every JS instruction. `navigation()` returns document milestones, paint entries, buffered longtasks and resource metadata.

Snapshots, screenshots, HAR and network bodies are not measurement outputs. Do not export personal UI snapshots with reports. Native-tool outputs should contain only opaque synthetic IDs and timing metadata.

## Summaries and quick checks

```sh
node apps/remote/web/performance/summarize.mjs /private/path/summary.json /private/path/sample-*.json
node --test apps/remote/web/performance/recorder.test.mjs
```

The summarizer deduplicates repeated cumulative recorder rows and emits per-case min/median/max, request start/header timing and resource sizes. Keep failed-predicate samples in the raw evidence and exclude them explicitly from accepted timing comparisons. Do not turn missing coverage into a zero-millisecond measurement.
