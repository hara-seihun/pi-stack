import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const families = ["anthropic-messages", "openai-codex-responses", "openai-completions", "openai-responses", "azure-openai-responses", "google-generative-ai", "google-vertex", "bedrock-converse-stream", "mistral-conversations", "pi-messages", "openrouter-images"];
const marker = "PiStack subscription-only inference boundary";
const helper = join(dirname(fileURLToPath(import.meta.url)), "subscription-only.mjs");

export function patchSubscriptionSource(source, family) {
  if (source.includes(marker)) return source;
  const names = family === "openrouter-images" ? ["generateImages"] : ["stream", "streamSimple"];
  let count = 0;
  const patched = source.replace(/\b(stream|streamSimple|streamAttempt|generateImages)\s*=\s*(?:async\s*)?\(model,\s*context,\s*options(?:\s*=\s*\{\})?\)\s*=>\s*\{/gu, (match, name) => {
    if (!names.includes(name) && name !== 'streamAttempt') return match;
    count++;
    const result = name === "generateImages" ? "rejectedImageInference(model, policy.error)" : "rejectedInferenceStream(model, policy.error)";
    return `${match}\nconst policy = authorizeInference(${JSON.stringify(family)}, model, options); if (!policy.ok) return ${result};\n`;
  });
  if (count !== names.length && !(family === 'openai-codex-responses' && count === 2)) throw new Error(`Pinned subscription boundary changed for ${family}: ${count} entrypoints`);
  return `import { authorizeInference, rejectedInferenceStream, rejectedImageInference } from "./subscription-only.mjs";\n// ${marker}\n${patched}`;
}

export function patchSubscriptionOnly(nodeModules) {
  const api = join(nodeModules, "@earendil-works/pi-ai/dist/api");
  const chunks = join(nodeModules, "@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const plans = [];
  for (const family of families) {
    const bundles = readdirSync(chunks).filter(name => name === `${family}.js` || name.startsWith(`${family}-`) && name.endsWith('.js'));
    if (bundles.length !== 1) throw new Error(`Expected one ${family} bundle, found ${bundles.length}`);
    for (const path of [join(api, `${family}.js`), join(chunks, bundles[0])]) plans.push([path, patchSubscriptionSource(readFileSync(path, "utf8"), family)]);
  }
  const policy = readFileSync(helper, 'utf8');
  for (const dir of [api, chunks]) writeFileSync(join(dir, 'subscription-only.mjs'), policy);
  for (const [path, source] of plans) writeFileSync(path, source);
  return plans.map(([path]) => path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-subscription-only.mjs NODE_MODULES");
  console.log(JSON.stringify({ patched: patchSubscriptionOnly(resolve(process.argv[2])).length }));
}
