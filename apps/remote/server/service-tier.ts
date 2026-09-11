import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionEnvironment } from "./session-environment";

/** Applies the per-thread speed mode maintained by the Pi Remote supervisor. */
export default function piRemoteServiceTier(pi: ExtensionAPI) {
  const path = sessionEnvironment().PI_REMOTE_SERVICE_TIER_FILE;
  if (!path) return;

  pi.on("before_provider_request", (event, context) => {
    if (context.model?.api !== "openai-codex-responses" && context.model?.api !== "openai-responses") return;
    let tier: string;
    try { tier = readFileSync(path, "utf8").trim(); }
    catch { return; }
    if (tier !== "default" && tier !== "priority") return;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return;
    return { ...payload, service_tier: tier };
  });
}
