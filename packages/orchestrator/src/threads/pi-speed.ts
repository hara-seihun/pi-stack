import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AsyncLocalStorage } from "node:async_hooks";

import { isSpeed, requestedSpeedError, type Speed } from "./speed.js";

export type ThreadSpeedUpdate = { ok: true; value: Speed } | { ok: false; error: string };

export function updateThreadSpeed(environment: NodeJS.ProcessEnv, value: unknown, model?: { provider: string; id: string }): ThreadSpeedUpdate {
  const error = requestedSpeedError(model, value);
  if (error) return { ok: false, error };
  if (!isSpeed(value)) return { ok: false, error: `Invalid thread speed: ${String(value)}` };
  environment.PI_THREAD_SPEED = value;
  return { ok: true, value };
}

export function threadSpeed(pi: ExtensionAPI) {
  const key = Symbol.for("pi-stack.session-environment");
  const environment = (globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<NodeJS.ProcessEnv> })[key]?.getStore() ?? process.env;
  pi.on("before_provider_request", (event, context) => {
    const speed = environment.PI_THREAD_SPEED ?? "standard";
    const error = requestedSpeedError(context.model, speed);
    if (error) throw new Error(error);
    if (!["openai-codex-responses", "openai-responses"].includes(context.model?.api ?? "")) return;
    if (!event.payload || typeof event.payload !== "object") return;
    return { ...event.payload as object, service_tier: speed === "standard" ? "default" : speed };
  });
}
