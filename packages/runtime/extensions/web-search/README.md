# Web search

Registers a native `web_search` tool and puts the search provider behind a plugin boundary. Agents see one tool whose shape never changes; the host decides which backend answers it.

Before this extension, the only retrieval tool in the list was the browser, and Exa lived in a skill an agent had to notice and load first. Agents drove a browser to a search engine instead. The tool definition sets Pi's `promptSnippet`, so `web_search` appears in the default system prompt's available-tools section for every session, and `promptGuidelines` tells the agent when a browser is still the right instrument.

## The tool

```
web_search(query, numResults?, category?, includeDomains?, excludeDomains?, startPublishedDate?, text?)
```

Results come back as a numbered list of title, URL, date, author and excerpt, with structured `details.results` for programmatic use. `text: true` returns extracted page text instead of an excerpt; it costs more and returns much more output, so the default is the excerpt. The tool runs in `parallel` execution mode: several searches in one batch proceed together.

## Backend selection

`~/.pi/agent/web-search.json`, or the path in `PI_STACK_WEB_SEARCH`:

```json
{ "version": 1, "backend": "exa", "defaultResults": 8 }
```

- A built-in id (`exa`) selects a shipped backend.
- `"none"` or `null` disables the tool.
- An object supplies a host backend: `{ "id": "house", "module": "/opt/house/search.mjs", "options": { "endpoint": "http://localhost:9000" } }`. The module path must be absolute, or a URL.
- No manifest file means the `exa` backend, so a new account gets web search without configuration.

A manifest error, a backend that fails to import, or a backend reporting itself unavailable leaves the tool unregistered and logs one line to stderr. A session never starts with a tool that cannot run. `PI_STACK_WEB_SEARCH_QUIET=1` silences that line.

## Backend contract

A backend module default-exports the backend object, or a factory taking `{ options, environment }` that returns one.

```js
export default {
  id: "house",
  label: "House index",          // named in the tool description and prompt snippet
  summary: "internal documents", // optional parenthetical in the description
  async status({ options, environment }) {
    return { available: true };  // or { available: false, reason: "..." }
  },
  async search(request, { options, environment, signal }) {
    return { results: [{ title, url, snippet, text, publishedDate, author, score }], notes: [] };
  },
};
```

`status()` runs once at session start and decides whether the tool exists at all. `search()` receives the tool parameters with `numResults` already defaulted and `text` always boolean. `notes` are appended to the rendered output; `usage` and `requestId` are carried into `details`. Throwing from `search()` returns the message to the agent, so transport refusals should be raised verbatim rather than translated.

## Exa backend

[`backends/exa.mjs`](backends/exa.mjs) writes an ordinary Exa request body to the host's `exa-api search` transport. That transport owns the Proton Pass credential, the machine-wide daily spend governor and per-session task attribution; this extension holds no API key and makes no network call of its own. Attribution works because the child process inherits `PI_SESSION_ID`.

Default requests ask for highlights rather than full text, which keeps an ordinary search inside the daily budget. `options.command` overrides the transport command and `options.type` overrides Exa's `auto` search type.

An account without `exa-api` on its PATH gets `available: false` and no tool, which is the correct outcome for accounts that cannot reach the credential. The governor's ownership rule is unchanged: an autonomous Projects Research task outside the `research-literature` lane is refused by the transport, and the refusal text reaches the agent unmodified.

## Tests

`node --test web-search.test.mjs` covers manifest parsing, backend loading and rejection, a host-supplied backend module, Exa request construction and result mapping, transport refusal, rendering, and registration through a fake Pi. The transport tests run a stand-in `exa-api` on a temporary PATH and spend nothing.
