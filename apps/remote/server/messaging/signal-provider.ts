import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { MessagingResult } from "./protocol";

export async function resolveSignalProvider(options: Record<string, unknown>, declaration = "/etc/pi-stack/raw-outbound-transports.json"): Promise<MessagingResult<string>> {
  if (options.rawExecutable !== undefined && options.binary !== undefined) return { ok: false, error: { code: "configuration", message: "Configure only one Signal provider executable." } };
  const explicit = options.rawExecutable !== undefined ? options.rawExecutable : options.binary;
  let candidate: unknown = explicit;
  if (explicit === undefined) {
    try {
      const providers: unknown = JSON.parse(await readFile(declaration, "utf8"));
      candidate = providers !== null && typeof providers === "object" && !Array.isArray(providers)
        ? (providers as Record<string, unknown>)["signal-cli"] : undefined;
    } catch {
      return { ok: false, error: { code: "unconfigured", message: "Signal has no installed host provider declaration. Deploy the owning outbound transport boundary or configure an absolute rawExecutable." } };
    }
  }
  if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate === "/usr/local/bin/signal-cli") return { ok: false, error: { code: explicit === undefined ? "unconfigured" : "configuration", message: "Signal requires a declared absolute provider executable, not the guarded agent command." } };
  return { ok: true, value: candidate };
}
