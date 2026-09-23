// The host manifest of local engines: which OpenAI-compatible servers exist on this machine, how to
// start one that is not running, and which models each one serves.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseReservation } from "./reservation.mjs";

export const DEFAULT_THINKING_LEVELS = { off: "none", minimal: "none", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" };

export function manifestPath(environment = process.env) {
  return environment.PI_STACK_LOCAL_MODELS || join(environment.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "local-models.json");
}

function fail(message) { throw new Error(`local-models manifest: ${message}`); }

export function parseManifest(text) {
  const raw = JSON.parse(text);
  if (raw?.version !== 1) fail("version must be 1");
  if (!Array.isArray(raw.engines)) fail("engines must be an array");
  const ids = new Set();
  const engines = raw.engines.map((engine, index) => {
    const where = `engines[${index}]`;
    if (typeof engine?.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(engine.id)) fail(`${where}.id must be a lowercase identifier`);
    if (ids.has(engine.id)) fail(`repeated engine id ${engine.id}`);
    ids.add(engine.id);
    if (typeof engine.baseUrl !== "string" || !/^https?:\/\//.test(engine.baseUrl)) fail(`${where}.baseUrl must be an http(s) URL`);
    if (!Array.isArray(engine.models) || engine.models.length === 0) fail(`${where}.models must list at least one model`);
    const models = engine.models.map((model, mi) => {
      if (typeof model?.id !== "string" || !model.id) fail(`${where}.models[${mi}].id is required`);
      if (typeof model.icon !== "string" || !model.icon.trim()) fail(`${where}.models[${mi}].icon is required: every model needs an icon, an emoji such as "🌳" or a Pi Remote asset name`);
      return {
        id: model.id,
        name: typeof model.name === "string" ? model.name : model.id,
        icon: model.icon.trim(),
        reasoning: model.reasoning === true,
        input: Array.isArray(model.input) ? model.input : ["text"],
        contextWindow: Number.isInteger(model.contextWindow) ? model.contextWindow : 8192,
        contextWindowExplicit: Number.isInteger(model.contextWindow),
        maxTokens: Number.isInteger(model.maxTokens) ? model.maxTokens : 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, ...(engine.compat && typeof engine.compat === "object" ? engine.compat : {}) },
        ...(model.reasoning === true ? { thinkingLevelMap: model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : DEFAULT_THINKING_LEVELS } : {}),
      };
    });
    let start;
    if (engine.start !== undefined) {
      if (!Array.isArray(engine.start?.command) || engine.start.command.length === 0 || engine.start.command.some((part) => typeof part !== "string")) fail(`${where}.start.command must be a non-empty array of strings`);
      start = {
        command: engine.start.command,
        unit: typeof engine.start.unit === "string" && engine.start.unit ? engine.start.unit : `local-model-${engine.id}`,
        cwd: typeof engine.start.cwd === "string" ? engine.start.cwd : undefined,
        readySeconds: Number.isFinite(engine.start.readySeconds) && engine.start.readySeconds > 0 ? engine.start.readySeconds : 120,
      };
    }
    return {
      id: engine.id,
      name: typeof engine.name === "string" ? engine.name : engine.id,
      baseUrl: engine.baseUrl.replace(/\/+$/u, ""),
      reservation: parseReservation(engine.reservation, fail, where),
      apiKey: typeof engine.apiKey === "string" && engine.apiKey ? engine.apiKey : "local",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, ...(engine.compat && typeof engine.compat === "object" ? engine.compat : {}) },
      models,
      start,
    };
  });
  return { engines };
}

export async function loadManifest(environment = process.env) {
  const path = manifestPath(environment);
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { engines: [], path, missing: true }; throw error; }
  return { ...parseManifest(text), path, missing: false };
}

/** The provider entry Pi's models.json and registerProvider both accept. */
export function providerConfig(engine) {
  const models = engine.models.map(({ contextWindowExplicit, ...model }) => model);
  return { name: engine.name, baseUrl: engine.baseUrl, api: "openai-completions", apiKey: engine.apiKey, compat: engine.compat, models };
}
