# Web search

Registers native `web_search` over an explicitly selected provider. The tool shape stays stable; the host owns provider selection and account access.

```
web_search(query, numResults?, category?, includeDomains?, excludeDomains?, startPublishedDate?, text?)
```

Results render as title, URL, date and excerpt. `text: true` requests page extraction through the selected provider and returns bounded full-page text. The tool uses parallel execution mode for independent searches. Use the browser for authenticated or interactive pages.

## Provider selection

Select in `~/.pi/agent/web-search.json`, or the path named by `PI_STACK_WEB_SEARCH`:

```json
{ "version": 1, "backend": "parallel", "defaultResults": 8 }
```

- `parallel` selects the shipped Parallel Web Systems transport adapter.
- `"none"` or `null` explicitly disables search.
- A host module is explicit: `{ "id": "house", "module": "/opt/house/search.mjs", "options": { "endpoint": "http://localhost:9000" } }`. Its path must be absolute or a module URL.
- An absent manifest or unset backend is an error, not permission to select another provider.

Configuration, import or availability failures leave the tool unregistered and log a reason; `PI_STACK_WEB_SEARCH_QUIET=1` silences that log. An already registered tool rereads selection and status before every call. Provider/options/default count changes do not require a reload. Local entry modules are imported by source hash; changes to their dependencies require an immutable new module path. An in-flight call retains its original selected provider. Failed or disabled current selection never falls back to an earlier provider.

## Parallel transport

[`backends/parallel.mjs`](backends/parallel.mjs) sends exactly one native search request as JSON stdin to the account's existing `parallel-search` command. `options.command` may explicitly name another installation of that same transport. The adapter holds no credential, reads no private transcript and does not contact the provider directly. The child inherits the calling account's environment and task attribution.

The owning host transport retrieves its already-approved Parallel credential, maps domain/date constraints and category preferences, and owns Search/Extract endpoint calls. Its response is `{ results, notes, requestId?, usage? }`. Each result contains `title`, public HTTP `url` and `snippet`; `publishedDate` and bounded `text` are optional. A malformed receipt is an error, not an empty successful search. Provider refusals such as missing access or exhausted prepaid credit return their cause and never trigger another provider, new billing or account provisioning. Transport requests have a 45-second deadline and a 12 MiB receipt bound.

Accounts without an executable authorized `parallel-search` command report unavailable. Provider selection does not grant another Unix account access to the host's credential. Before staged adoption, the host owner must establish explicit manifest selection and the approved account transport. Credential custody and any required access repair remain in the host's secret-store handbook; secrets never enter this manifest or repository.

## Host backend contract

A module default-exports an object, or a factory receiving `{ options, environment }`:

```js
export default {
  id: "house", label: "House index", summary: "internal documents",
  async status({ options, environment }) {
    return { available: true };
  },
  async search(request, { options, environment, signal }) {
    return { results: [{ title: "Title", url: "https://example.com", snippet: "Excerpt" }], notes: [] };
  },
};
```

`status` controls registration and per-call availability. `search` receives validated native tool fields, an explicit result count and boolean `text`. Notes render after results; usage and request identity travel in tool details. Provider transport failures remain explicit.

## Offline proof

`node --test web-search.test.mjs` exercises explicit selection, actual child transport, query/filter/extraction preservation, receipt validation, provider refusal without fallback, rendering, registration and long-lived selection changes. Fixtures use synthetic executables and temporary manifests; no credentials, provider requests or paid usage occur.
