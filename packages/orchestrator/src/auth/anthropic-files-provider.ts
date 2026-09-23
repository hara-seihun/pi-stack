import { homedir } from "node:os";
import { join } from "node:path";
import type { Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { rewriteAnthropicImages } from "../anthropic-files.js";

export function anthropicFilesCacheRoot(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-stack", "anthropic-files");
}

export function anthropicFilesHeaders(model: Model<any>, options?: StreamOptions): Headers {
  const headers = new Headers({ "anthropic-version": "2023-06-01" });
  if (options?.apiKey) {
    if (options.apiKey.includes("sk-ant-oat")) headers.set("authorization", `Bearer ${options.apiKey}`);
    else headers.set("x-api-key", options.apiKey);
  }
  for (const source of [model.headers, options?.headers]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(key);
      else headers.set(key, value);
    }
  }
  if (headers.get("authorization")?.includes("sk-ant-oat")) {
    const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()).filter(Boolean));
    betas.add("oauth-2025-04-20");
    headers.set("anthropic-beta", [...betas].join(","));
  }
  headers.delete("content-type");
  headers.delete("content-length");
  return headers;
}

export function withAnthropicFiles(provider: Provider, cacheRoot = anthropicFilesCacheRoot()): Provider {
  if (provider.id !== "anthropic") return provider;
  const prepare = <T extends StreamOptions>(options?: T): T => ({
    ...options,
    onPayload: async (payload: unknown, model: Model<any>) => {
      const replacement = await options?.onPayload?.(payload, model);
      const current = replacement === undefined ? payload : replacement;
      if (model.api !== "anthropic-messages") return current;
      const signal = options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(45_000)])
        : AbortSignal.timeout(45_000);
      const result = await rewriteAnthropicImages({
        payload: current,
        cacheRoot,
        scope: model.provider,
        baseUrl: model.baseUrl,
        headers: anthropicFilesHeaders(model, options),
        signal,
        fetch: options?.fetch,
      });
      if (!result.ok) throw new Error(`Anthropic Files API: ${JSON.stringify(result.error)}`);
      return result.value;
    },
  } as T);
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, prepare(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, prepare(options)),
  };
}
