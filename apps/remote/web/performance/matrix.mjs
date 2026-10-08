import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const destinations = [
  { name: "chats-nav", label: "Chats", scope: "#app", ready: '.pane-list input[type="search"]', absent: null, loading: null },
  { name: "agents-nav", label: "Agents", scope: ".pane-detail", ready: ".agents-screen", absent: ".agents-refresh:disabled", loading: null },
  { name: "notifications-nav", label: "Notifications", scope: ".pane-detail", ready: ".notifications-screen", absent: ".notifications-refresh:disabled", loading: null },
  { name: "needs-you-nav", label: "Needs you", scope: ".pane-detail", ready: ".needs-you-items", absent: '.needs-you-screen [role="status"]', loading: null },
  { name: "calendar-nav", label: "Calendar", scope: ".pane-detail", ready: ".calendar-screen", absent: null, loading: { selector: ".calendar-screen > p", texts: ["Loading calendar…"] } },
  { name: "files-nav", label: "Files", scope: ".pane-detail", ready: ".files-tree-row", absent: ".files-tree-loading", loading: { selector: ".files-tree-name", texts: ["Loading…"] } },
  { name: "machine-nav", label: "Machine", scope: ".pane-detail", ready: ".machine-screen", absent: null, loading: null },
];

export function measureSteps({ name, cache, trigger, scope, ready, absent, loading }, action, quietMs, timeoutMs) {
  const spec = { name, cache, trigger, scope, ready, absent, loading, quietMs, timeoutMs };
  return [["get", "url"], ["eval", `piClientTiming.arm(${JSON.stringify(spec)})`], ["get", "url"], action, ["get", "url"], ["eval", "piClientTiming.take()"]];
}

export function matrixSteps({ cache, rounds, names, quietMs, timeoutMs }) {
  const cases = names.map(name => destinations.find(destination => destination.name === name));
  if (cases.some(value => !value)) return { ok: false, error: "unknown-case" };
  if (new Set(names).size !== names.length || rounds < 1 || cases.length < 2) return { ok: false, error: "invalid-matrix" };
  const steps = [["get", "url"], ["eval", `window.piTimingCases=${JSON.stringify(destinations)};window.piArmCase=(name,cache)=>{const item=piTimingCases.find(value=>value.name===name);if(!item)return {ok:false,error:'unknown-case'};const trigger='nav[aria-label="Sections"] button[title="'+item.label+'"]';return piClientTiming.arm({...item,trigger,cache,quietMs:${quietMs},timeoutMs:${timeoutMs}})}`], ["get", "url"]];
  for (let round = 0; round < rounds; round++) {
    for (const item of cases) {
      const trigger = `nav[aria-label="Sections"] button[title="${item.label}"]`;
      steps.push(["get", "url"], ["eval", `piArmCase(${JSON.stringify(item.name)},${JSON.stringify(`${cache}-${round + 1}`)})`], ["get", "url"], ["click", trigger], ["get", "url"], ["eval", "piClientTiming.take()"]);
    }
  }
  steps.push(["get", "url"], ["eval", "piClientTiming.all()"]);
  return { ok: true, steps };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, configPath, outputPath] = process.argv.slice(2);
  if (command === "install" && configPath && outputPath === undefined) {
    const source = readFileSync(new URL("recorder.js", import.meta.url), "utf8");
    writeFileSync(configPath, JSON.stringify({ args: ["eval", "--stdin"], stdin: source }, null, 2));
  } else if (command === "matrix" && configPath && outputPath) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof config.cache !== "string" || !Number.isInteger(config.rounds) || !Array.isArray(config.names) || !(config.quietMs > 0) || !(config.timeoutMs > config.quietMs) || typeof config.outputPath !== "string" || !(config.toolTimeoutMs > config.timeoutMs)) throw new Error("Explicit matrix configuration required");
    const result = matrixSteps(config);
    if (!result.ok) throw new Error(result.error);
    writeFileSync(outputPath, JSON.stringify({ args: ["batch", "--bail"], stdin: JSON.stringify(result.steps), outputPath: config.outputPath, timeoutMs: config.toolTimeoutMs }, null, 2));
  } else {
    process.stderr.write("Usage: node matrix.mjs install OUTPUT_TOOL_JSON | matrix CONFIG_JSON OUTPUT_TOOL_JSON\n");
    process.exitCode = 2;
  }
}
