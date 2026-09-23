// Exa backend. It sends an ordinary Exa request body to the host's `exa-api search` transport, which
// owns credentials, the machine-wide daily spend budget and task attribution. This file holds no key
// and makes no network call of its own.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const DEFAULT_COMMAND = "exa-api";
const TEXT_CHARACTERS = 4000;
const SNIPPET_CHARACTERS = 1200;

export function resolveCommand(command, environment = process.env) {
  if (command.includes("/")) return executable(command) ? command : undefined;
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The Exa request body for one tool call. */
export function exaRequest(request, options = {}) {
  const contents = request.text
    ? { text: { maxCharacters: options.textCharacters ?? TEXT_CHARACTERS } }
    : { highlights: { numSentences: 3, highlightsPerUrl: 2 } };
  return {
    query: request.query,
    type: options.type ?? "auto",
    numResults: request.numResults,
    ...(request.category ? { category: request.category } : {}),
    ...(request.includeDomains?.length ? { includeDomains: request.includeDomains } : {}),
    ...(request.excludeDomains?.length ? { excludeDomains: request.excludeDomains } : {}),
    ...(request.startPublishedDate ? { startPublishedDate: request.startPublishedDate } : {}),
    contents,
  };
}

function clip(text, limit) {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Exa's response shape reduced to the backend contract. */
export function exaResults(response) {
  const results = Array.isArray(response?.results) ? response.results : [];
  return results.map((result) => ({
    title: result.title || result.url,
    url: result.url,
    publishedDate: result.publishedDate ?? undefined,
    author: result.author ?? undefined,
    score: typeof result.score === "number" ? result.score : undefined,
    snippet: clip(Array.isArray(result.highlights) ? result.highlights.join(" … ") : result.summary ?? result.text ?? "", SNIPPET_CHARACTERS),
    text: typeof result.text === "string" && result.text ? result.text : undefined,
  }));
}

export function runTransport(command, argv, body, { signal, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"], env: environment, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(body)}\n`);
  });
}

const backend = {
  id: "exa",
  label: "Exa",
  summary: "Exa neural and keyword web search",

  async status({ options = {}, environment = process.env } = {}) {
    const command = options.command ?? DEFAULT_COMMAND;
    const resolved = resolveCommand(command, environment);
    if (!resolved) {
      return { available: false, reason: `${command} is not an executable on PATH; this account cannot reach the Exa transport` };
    }
    return { available: true, detail: resolved };
  },

  async search(request, { options = {}, environment = process.env, signal } = {}) {
    const command = options.command ?? DEFAULT_COMMAND;
    const resolved = resolveCommand(command, environment) ?? command;
    const body = exaRequest(request, options);
    const { code, stdout, stderr } = await runTransport(resolved, ["search"], body, { signal, environment });
    if (code !== 0) {
      const detail = (stderr.trim() || stdout.trim() || `exit ${code}`).slice(0, 2000);
      throw new Error(`Exa search failed: ${detail}`);
    }
    let response;
    try {
      response = JSON.parse(stdout);
    } catch {
      throw new Error(`Exa returned a response that is not JSON: ${stdout.trim().slice(0, 500)}`);
    }
    if (response?.error) throw new Error(`Exa search failed: ${typeof response.error === "string" ? response.error : JSON.stringify(response.error)}`);
    const notes = [];
    if (stderr.trim()) notes.push(stderr.trim().slice(0, 500));
    if (response?.costDollars?.total !== undefined) notes.push(`cost $${response.costDollars.total}`);
    return {
      results: exaResults(response),
      notes,
      usage: response?.costDollars ? { costDollars: response.costDollars } : undefined,
      requestId: response?.requestId,
      resolvedType: response?.resolvedSearchType,
    };
  },
};

export default backend;
