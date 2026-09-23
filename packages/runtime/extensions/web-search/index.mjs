// Web search as a first-class tool. The host picks a backend; agents see one `web_search` tool in
// the system prompt's tool list, so searching the web does not depend on noticing a skill first.
import { loadBackend, loadManifest } from "./manifest.mjs";
import { formatResults, searchParameters } from "./tool.mjs";

export default async function webSearch(pi) {
  const environment = process.env;
  const log = (message) => { if (environment.PI_STACK_WEB_SEARCH_QUIET !== "1") console.error(`[web-search] ${message}`); };

  let manifest;
  try { manifest = await loadManifest(environment); }
  catch (error) { log(`manifest error: ${error.message}`); return; }
  if (!manifest.backend) return;

  let backend;
  try { backend = await loadBackend(manifest.backend, { environment }); }
  catch (error) { log(`backend ${manifest.backend.id} failed to load: ${error.message}`); return; }

  let status;
  try { status = await backend.status({ options: backend.options, environment }); }
  catch (error) { status = { available: false, reason: error.message }; }
  if (!status?.available) {
    log(`${backend.id} unavailable: ${status?.reason ?? "no reason given"}`);
    return;
  }

  const defaultResults = manifest.defaultResults;
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    parameters: searchParameters(defaultResults),
    promptSnippet: `web_search: search the live web through ${backend.label} and get ranked results with page excerpts.`,
    promptGuidelines: [
      "Use web_search to find pages and check current facts; it is cheaper and faster than opening a browser to search. Follow up with the browser or a fetch when you need the full page or an authenticated view.",
    ],
    description: [
      `Search the live web through ${backend.label}${backend.summary ? ` (${backend.summary})` : ""}. Returns ranked results with title, URL, publication date and an excerpt, optionally the extracted page text.`,
      "Reach for this first when you need to find pages or check something current. It answers in one call, without a browser session. Use the browser afterwards for a full page, an interactive site or anything needing a signed-in profile, and fetch a known URL directly instead of searching for it.",
      "Write the query the way you would describe the page you want. Narrow with domains, a publication date floor or a category rather than by repeating the search.",
    ].join("\n\n"),
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate) {
      const query = params.query?.trim();
      if (!query) throw new Error("query cannot be blank");
      const request = {
        query,
        numResults: params.numResults ?? defaultResults,
        category: params.category,
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
        startPublishedDate: params.startPublishedDate,
        text: params.text === true,
      };
      onUpdate?.({ content: [{ type: "text", text: `Searching ${backend.label}…` }], details: {} });
      const response = await backend.search(request, { options: backend.options, environment, signal });
      const results = Array.isArray(response?.results) ? response.results : [];
      return {
        content: [{ type: "text", text: formatResults(query, results, response?.notes, backend.label) }],
        details: {
          backend: backend.id,
          query,
          results: results.map(({ title, url, publishedDate, author, score }) => ({ title, url, publishedDate, author, score })),
          ...(response?.usage ? { usage: response.usage } : {}),
          ...(response?.requestId ? { requestId: response.requestId } : {}),
        },
      };
    },
  });
}
