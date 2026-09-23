// Pi's ~/.pi/agent/models.json is the model catalog every Pi surface reads, including PiStack's thread
// model list. Engines are written there as providers; other providers in the file are left alone.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { providerConfig } from "./manifest.mjs";

export function catalogPath(environment = process.env) {
  return join(environment.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent"), "models.json");
}

export function mergeCatalog(current, engines, stale = []) {
  const providers = { ...(current?.providers ?? {}) };
  for (const id of stale) delete providers[id];
  for (const engine of engines) providers[engine.id] = providerConfig(engine);
  return { ...(current ?? {}), providers };
}

/** Write the engines into the catalog. Returns true when the file changed. */
export async function syncCatalog(engines, { environment = process.env, stale = [] } = {}) {
  const path = catalogPath(environment);
  let current = {};
  let currentText = "";
  try { currentText = await readFile(path, "utf8"); current = JSON.parse(currentText); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const next = `${JSON.stringify(mergeCatalog(current, engines, stale), null, 2)}\n`;
  if (next === currentText) return false;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return true;
}
