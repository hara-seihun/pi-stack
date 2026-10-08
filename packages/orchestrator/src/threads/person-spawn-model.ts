import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** Service-owner configuration. Never accept a person ID from spawn metadata/caller text.
 * The same registry is read by Remote and by the person's separate Orchestrator daemon.
 * Read at admission so a preference update needs no worker/session interruption. Rooms
 * deliberately have no personal default. Missing registration preserves legacy defaults;
 * unreadable/malformed registration fails closed rather than choosing a different model.
 */
export function configuredPersonSpawnModel(env: NodeJS.ProcessEnv = process.env, person = userInfo().username): string | undefined {
  if (env.PI_REMOTE_ROOMS_RUNTIME === "1") return undefined;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(person)) throw new Error("Invalid service owner for spawn defaults");
  let model: unknown;
  try {
    const registry = JSON.parse(readFileSync(join(env.PI_REMOTE_PERSONS_DIR ?? "/var/lib/pi-remote/persons", `${person}.json`), "utf8"));
    if (registry.version !== 1 || registry.user !== person || !registry.environment || typeof registry.environment !== "object" || Array.isArray(registry.environment))
      throw new Error("Invalid service-owner registry for spawn defaults");
    model = registry.environment.PI_THREAD_DEFAULT_MODEL;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Service-owner spawn defaults are unavailable");
    model = env.PI_THREAD_DEFAULT_MODEL;
  }
  if (model === undefined) return undefined;
  if (typeof model !== "string" || !model.trim()) throw new Error("Invalid service-owner default model");
  return model;
}
