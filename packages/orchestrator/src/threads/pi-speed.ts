import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AsyncLocalStorage } from "node:async_hooks";

import { isSpeed, modelSpeedModes, type Speed } from "./speed.js";

export type ThreadSpeedUpdate = { ok: true; value: Speed } | { ok: false; error: string };

export function updateThreadSpeed(environment: NodeJS.ProcessEnv, value: unknown, model?: { provider: string; id: string }): ThreadSpeedUpdate {
  if (!isSpeed(value)) return { ok: false, error: `Invalid thread speed: ${String(value)}` };
  if (value === "ultrafast" && !modelSpeedModes(model?.provider ?? "", model?.id ?? "").includes(value)) return { ok: false, error: "Ultrafast speed requires OpenAI Codex Astra" };
  environment.PI_THREAD_SPEED = value;
  return { ok: true, value };
}

export function threadSpeed(pi: ExtensionAPI) {
  const key = Symbol.for("pi-stack.session-environment");
  const environment = (globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<NodeJS.ProcessEnv> })[key]?.getStore() ?? process.env;
  pi.on("before_provider_request", (event, context) => {
    if (!["openai-codex-responses", "openai-responses"].includes(context.model?.api ?? "")) return;
    const speed = environment.PI_THREAD_SPEED ?? "standard";
    if (!isSpeed(speed)) throw new Error(`Invalid thread speed: ${speed}`);
    if (speed === "ultrafast" && !modelSpeedModes(context.model?.provider ?? "", context.model?.id ?? "").includes(speed)) throw new Error("Ultrafast speed requires OpenAI Codex Astra");
    if (!event.payload || typeof event.payload !== "object") return;
    return { ...event.payload as object, service_tier: speed === "standard" ? "default" : speed };
  });
}
