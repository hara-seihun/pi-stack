import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUBSCRIPTION_ONLY_CODE = "nonvoice_metered_inference_forbidden";
const denied = () => ({ ok: false, error: { code: SUBSCRIPTION_ONLY_CODE, message: "Nonvoice inference requires the subscription pool/broker or a configured local engine." } });

function endpoint(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url;
  } catch { return undefined; }
}

function privateHost(host) {
  if (host === 'localhost' || host === '[::1]' || /^\[(?:fc|fd)/i.test(host)) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = parts;
  return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127;
}

function localEngine(model, url, family, env) {
  if (family !== "openai-completions" || !privateHost(url.hostname)) return false;
  const path = env.PI_STACK_LOCAL_MODELS || join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "local-models.json");
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); }
  catch { return false; }
  return Array.isArray(manifest?.engines) && manifest.engines.some(engine => engine.id === model.provider && engine.publish !== false && endpoint(engine.baseUrl)?.href.replace(/\/+$/u, "") === url.href.replace(/\/+$/u, ""));
}

/** @returns {{ok:true,route:'broker'|'subscription-oauth'|'local-engine'}|{ok:false,error:{code:string,message:string}}} */
export function authorizeInference(family, model, options, env = process.env) {
  const url = endpoint(model?.baseUrl);
  if (!url) return denied();
  const headers = new Map();
  for (const source of [model.headers, options?.headers]) {
    for (const [key, value] of Object.entries(source || {})) headers.set(key.toLowerCase(), value);
  }
  const key = options?.apiKey;
  if (localEngine(model, url, family, env)) return { ok: true, route: "local-engine" };
  if ([...headers.keys()].some(name => ['x-api-key', 'api-key', 'x-goog-api-key'].includes(name))) return denied();
  const bearer = headers.get('authorization');
  if (bearer !== undefined && (typeof key !== 'string' || bearer !== `Bearer ${key}`)) return denied();
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port;
  if (loopback && ((family === "anthropic-messages" && key === "sk-ant-oat01-pi-model-broker") || (family === "openai-codex-responses" && typeof key === "string" && key.startsWith("broker.") && key.endsWith(".not-a-credential")))) return { ok: true, route: "broker" };
  if (family === "anthropic-messages" && url.origin === "https://api.anthropic.com" && ['/', '/v1', '/v1/'].includes(url.pathname) && typeof key === "string" && /^sk-ant-oat\d+-/.test(key) && key !== "sk-ant-oat01-pi-model-broker") return { ok: true, route: "subscription-oauth" };
  if (family === "openai-codex-responses" && url.origin === "https://chatgpt.com" && /^\/backend-api(?:\/codex(?:\/responses)?)?\/?$/.test(url.pathname) && typeof key === "string") {
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
      if (key.startsWith('eyJ') && typeof payload?.['https://api.openai.com/auth']?.chatgpt_account_id === 'string') return { ok: true, route: "subscription-oauth" };
    } catch { return denied(); }
  }
  return denied();
}

export function inferenceError(model, error) {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorCode: error.code, errorMessage: `${error.code}: ${error.message}`, timestamp: Date.now() };
}

export function rejectedInferenceStream(model, error) {
  const message = inferenceError(model, error);
  return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: "error", reason: "error", error: message }; } };
}

export function rejectedImageInference(model, error) {
  return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: "error", errorCode: error.code, errorMessage: `${error.code}: ${error.message}`, timestamp: Date.now() };
}
