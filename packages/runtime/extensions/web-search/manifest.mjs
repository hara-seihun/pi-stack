// Which search backend this host uses. The tool is the same everywhere; the backend behind it is a
// plugin, so a host can change search providers without changing the agent-facing tool.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Backends shipped with the stack, by id. */
export const BUILT_IN_BACKENDS = {
  exa: new URL("./backends/exa.mjs", import.meta.url).href,
};

export const DEFAULT_BACKEND = "exa";

export function manifestPath(environment = process.env) {
  if (environment.PI_STACK_WEB_SEARCH) return environment.PI_STACK_WEB_SEARCH;
  return join(environment.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "web-search.json");
}

function fail(message) {
  throw new Error(`web-search manifest: ${message}`);
}

function parseBackend(backend) {
  if (backend === "none" || backend === null) return null;
  if (typeof backend === "string") {
    if (!BUILT_IN_BACKENDS[backend]) fail(`unknown backend ${backend}; built-in backends are ${Object.keys(BUILT_IN_BACKENDS).join(", ")}, or give a module path`);
    return { id: backend, module: BUILT_IN_BACKENDS[backend], options: {} };
  }
  if (typeof backend !== "object" || Array.isArray(backend)) fail("backend must be a backend id, an object, or \"none\"");
  const { id, module, options } = backend;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) fail("backend.id must be a lowercase identifier");
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) fail("backend.options must be an object");
  if (module === undefined) {
    if (!BUILT_IN_BACKENDS[id]) fail(`backend ${id} has no module and is not built in`);
    return { id, module: BUILT_IN_BACKENDS[id], options: options ?? {} };
  }
  if (typeof module !== "string" || !module) fail("backend.module must be a path or URL");
  const resolved = module.includes("://") ? module : isAbsolute(module) ? pathToFileURL(module).href : fail("backend.module must be an absolute path or a URL");
  return { id, module: resolved, options: options ?? {} };
}

export function parseManifest(text) {
  const raw = JSON.parse(text);
  if (raw?.version !== 1) fail("version must be 1");
  if (raw.defaultResults !== undefined && (!Number.isInteger(raw.defaultResults) || raw.defaultResults < 1 || raw.defaultResults > 25)) {
    fail("defaultResults must be an integer between 1 and 25");
  }
  return {
    backend: parseBackend(raw.backend === undefined ? DEFAULT_BACKEND : raw.backend),
    defaultResults: raw.defaultResults ?? 8,
  };
}

/** The host's selection, or the default backend when no manifest exists. */
export async function loadManifest(environment = process.env) {
  const path = manifestPath(environment);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { backend: parseBackend(DEFAULT_BACKEND), defaultResults: 8, path, missing: true };
  }
  return { ...parseManifest(text), path, missing: false };
}

/**
 * Import a backend module and check it against the backend contract. A module default-exports the
 * backend object, or a factory taking `{ options, environment }` and returning one.
 */
export async function loadBackend(selection, context = {}) {
  const imported = await import(selection.module);
  const exported = imported.default ?? imported.backend;
  if (!exported) throw new Error(`backend ${selection.id} exports no default backend`);
  const backend = typeof exported === "function" ? await exported({ options: selection.options, environment: context.environment ?? process.env }) : exported;
  if (typeof backend?.search !== "function") throw new Error(`backend ${selection.id} has no search(request, context) function`);
  return {
    id: backend.id ?? selection.id,
    label: backend.label ?? backend.id ?? selection.id,
    summary: backend.summary ?? "",
    options: selection.options,
    status: typeof backend.status === "function" ? backend.status.bind(backend) : async () => ({ available: true }),
    search: backend.search.bind(backend),
  };
}
