import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function measurements(value, into) {
  if (Array.isArray(value)) { for (const item of value) measurements(item, into); return; }
  if (!value || typeof value !== "object") return;
  if (typeof value.name === "string" && typeof value.state === "string" && typeof value.observationMs === "number") {
    into.set(JSON.stringify(value), value);
    return;
  }
  if ("result" in value) measurements(value.result, into);
}
function range(values) {
  const sorted = values.filter(value => typeof value === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1) };
}
export function summarize(inputs) {
  const samples = new Map();
  for (const input of inputs) measurements(input, samples);
  const groups = new Map();
  for (const value of samples.values()) {
    const key = `${value.name}/${value.cache}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return [...groups.entries()].map(([scenario, rows]) => ({
    scenario, samples: rows.length, states: rows.map(row => row.state), triggerEvents: rows.map(row => row.triggerEvent ?? null),
    firstRenderMs: range(rows.map(row => row.firstRenderMs)), usableMs: range(rows.map(row => row.usableMs)), settledMs: range(rows.map(row => row.settledMs)),
    longTaskMs: range(rows.map(row => row.longTasks.totalMs)), maxFrameGapMs: range(rows.map(row => row.frames.maxGapMs)),
    requests: rows.flatMap(row => row.requests.map(request => ({ method: request.method, route: request.route, status: request.status, startMs: request.startMs, headersMs: request.headersMs }))),
    resources: rows.flatMap(row => row.resources.map(resource => ({ route: resource.route, firstByteMs: resource.firstByteMs, bodyMs: resource.bodyMs, decodedBytes: resource.decodedBytes, status: resource.status }))),
  }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || !inputs.length) {
    process.stderr.write("Usage: node summarize.mjs OUTPUT_JSON INPUT_JSON...\n");
    process.exitCode = 2;
  } else writeFileSync(output, JSON.stringify(summarize(inputs.map(file => JSON.parse(readFileSync(file, "utf8")))), null, 2));
}
