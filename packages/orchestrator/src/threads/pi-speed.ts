import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AsyncLocalStorage } from "node:async_hooks";

export type ThreadSpeed = "standard" | "priority";
export type ThreadSpeedUpdate = { ok: true; value: ThreadSpeed } | { ok: false; error: string };

export function updateThreadSpeed(environment: NodeJS.ProcessEnv, value: unknown): ThreadSpeedUpdate {
  if (value !== "standard" && value !== "priority") return { ok: false, error: `Invalid thread speed: ${String(value)}` };
  environment.PI_THREAD_SPEED = value;
  return { ok: true, value };
}

export function threadSpeed(pi: ExtensionAPI) {
  const key = Symbol.for("pi-stack.session-environment");
  const environment = (globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<NodeJS.ProcessEnv> })[key]?.getStore() ?? process.env;
  pi.on("before_provider_request", (event, context) => {
    if (!["openai-codex-responses", "openai-responses"].includes(context.model?.api ?? "")) return;
    const speed = environment.PI_THREAD_SPEED ?? "standard";
    if (speed !== "standard" && speed !== "priority") throw new Error(`Invalid thread speed: ${speed}`);
    if (!event.payload || typeof event.payload !== "object") return;
    return { ...event.payload as object, service_tier: speed === "priority" ? "priority" : "default" };
  });
}
