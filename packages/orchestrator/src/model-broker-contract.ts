import type { ModelAuth, Provider } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.js";

export const BROKER_ENV = "PI_MODEL_BROKER_URL";
export const BROKER_ROUTES = {
  "openai-codex": { path: "/backend-api/codex/responses", upstream: "https://chatgpt.com/backend-api/codex/responses" },
  anthropic: { path: "/v1/messages", upstream: "https://api.anthropic.com/v1/messages" },
} as const;
export type BrokerFamily = keyof typeof BROKER_ROUTES;

export function modelBrokerUrl(env: NodeJS.ProcessEnv = process.env, configPath?: string): string | undefined {
  const value = env[BROKER_ENV] ?? loadConfig(configPath, undefined, env).modelBrokerUrl;
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`modelBrokerUrl / ${BROKER_ENV} must be http://127.0.0.1:PORT`);
  }
  return url.origin;
}

// These public markers satisfy the native adapters' local OAuth-format checks.
// They are not credentials and the broker never accepts them as authentication.
export function brokerModelAuth(family: BrokerFamily, baseUrl: string): ModelAuth {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "pi-model-broker" } })).toString("base64url");
  return { baseUrl: family === "openai-codex" ? `${baseUrl}/backend-api` : baseUrl, apiKey: family === "anthropic" ? "sk-ant-oat01-pi-model-broker" : `broker.${payload}.not-a-credential` };
}

export function brokerProvider(family: Provider, baseUrl: string): Provider {
  const auth = brokerModelAuth(family.id as BrokerFamily, baseUrl);
  const model = (value: Parameters<Provider["streamSimple"]>[0]) => ({ ...value, baseUrl: auth.baseUrl! });
  return {
    ...family,
    baseUrl,
    auth: { apiKey: { name: "Unix-user model broker", resolve: async () => ({ auth, source: "Unix-user model broker" }) } },
    getModels: () => family.getModels().map(model),
    stream: (value, context, options) => family.stream(model(value), context, { ...options, ...auth, transport: "sse" }),
    streamSimple: (value, context, options) => family.streamSimple(model(value), context, { ...options, ...auth, transport: "sse" }),
  };
}

type Json = Record<string, any>;
export function validateBrokerBody(family: BrokerFamily, body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected a JSON object";
  const request = body as Json;
  if (typeof request.model !== "string" || !request.model || request.stream !== true) return "A model and stream:true are required";
  const forbidden = new Set(["previous_response_id", "conversation", "container", "file_id", "file_url", "vector_store_ids", "mcp_servers"]);
  const inspect = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(inspect);
    return Object.entries(value).some(([key, child]) => {
      if (["parameters", "input_schema", "schema", "arguments"].includes(key) || key === "input" && (value as Json).type === "tool_use") return false;
      return forbidden.has(key) && child != null
        || key === "image_url" && (typeof child !== "string" || !child.startsWith("data:image/"))
        || key === "type" && ["item_reference", "file", "reference", "url", "server_tool_use"].includes(String(child))
        || inspect(child);
    });
  };
  if (inspect(request)) return "Stored provider resources are not available through the model broker";
  if (family === "openai-codex") {
    if (request.store !== false || !Array.isArray(request.input)) return "Codex requests require store:false and inline input";
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.some((tool: Json) => !tool || !["function", "image_generation"].includes(tool.type)))) return "Only client functions and image generation are available";
  } else {
    if (!Array.isArray(request.messages)) return "Anthropic requests require inline messages";
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.some((tool: Json) => !tool || tool.type !== undefined && tool.type !== "custom"))) return "Only client tools are available";
  }
  return undefined;
}
