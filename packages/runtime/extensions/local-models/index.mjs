// Local models: engines listed in the host manifest become Pi providers. A listed engine that is not
// answering is started (a transient user unit) before its models are registered, so choosing the
// model is enough to bring the engine up.
import { loadManifest, providerConfig } from "./manifest.mjs";
import { ensureEngine, listModels, applyAdvertised } from "./engine.mjs";
import { syncCatalog } from "./catalog.mjs";

export default async function localModels(pi) {
  const environment = process.env;
  const log = (message) => { if (environment.PI_STACK_LOCAL_MODELS_QUIET !== "1") console.error(`[local-models] ${message}`); };
  let manifest;
  try { manifest = await loadManifest(environment); }
  catch (error) { log(`manifest error: ${error.message}`); return; }
  if (manifest.missing) return;
  const ready = [];
  const reserved = [];
  const down = [];
  for (const engine of manifest.engines) {
    const state = await ensureEngine(engine, { environment, log });
    if (state.ready) { ready.push(applyAdvertised(engine, await listModels(engine.baseUrl))); if (state.launched) log(`${engine.id} is up (${state.detail})`); }
    // A reservation is a pause somebody else is holding, not a broken engine: keep the models in the
    // catalog and registered so the picker does not lose them, and let the request fail while it lasts.
    else if (state.reserved) { reserved.push(engine); log(`${engine.id} ${state.detail}; not starting it`); }
    else { down.push(engine); log(`${engine.id} unavailable: ${state.detail}`); }
  }
  for (const engine of [...ready, ...reserved]) pi.registerProvider(engine.id, providerConfig(engine));
  try { await syncCatalog([...ready, ...reserved], { environment, stale: down.map((engine) => engine.id) }); }
  catch (error) { log(`catalog update failed: ${error.message}`); }
}
