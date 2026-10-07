import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const standalone = /(?:\/pi-coding-agent\/dist\/(?:bundle\/)?cli\.js|\/(?:node_modules\/\.bin|\.local\/bin)\/pi|\/(?:stack-agent|stack-pi|browser-doctor|model-selection-doctor|image-generation-probe)\.mjs|\/pi-(?:agent-browser|model-selection)-doctor|\/read-condensed-session\/(?:main|runtime\.mjs)|\/codex-compaction\/smoke\.mjs|\/one-kenan-(?:memory|closure)-acceptance\.ts)$/;
const rootSession = /\/kenan-root\/(?:src|dist)\/main\.(?:ts|js)$/;
export function directAgentProcessProof(procRoot, retained, gatedRootPid) {
  if (!retained || retained.version !== 1 || !Array.isArray(retained.processes) || retained.processes.some(row => !row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || ![row.processStart, row.ownerId, row.agentId, row.executionId].every(value => typeof value === "string" && value.length > 0))) throw new Error("Explicit retained direct-process custody receipt is required");
  const processes = new Map();
  for (const id of readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(join(procRoot, id, "stat"), "utf8").split(") ").at(-1).split(" ");
      if (!/^\d+$/.test(stat[1] ?? "") || !/^\d+$/.test(stat[19] ?? "")) throw new Error("Invalid process identity");
      const args = readFileSync(join(procRoot, id, "cmdline"), "utf8").split("\0").filter(Boolean);
      processes.set(Number(id), { pid: Number(id), parent: Number(stat[1]), processStart: stat[19], direct: args.some(arg => standalone.test(arg) || rootSession.test(arg) || /createAgentSession|createFixedSession/.test(arg)) });
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw new Error(`Process census unavailable for PID ${id}: ${error.code}`); }
  }
  const oldProcesses = [], retainedProcesses = [];
  for (const process of processes.values()) {
    if (!process.direct || process.pid === gatedRootPid) continue;
    let ancestor = process, custody;
    const visited = new Set();
    while (ancestor && !visited.has(ancestor.pid)) {
      visited.add(ancestor.pid);
      custody = retained.processes.find(row => row.pid === ancestor.pid && row.processStart === ancestor.processStart);
      if (custody) break;
      ancestor = processes.get(ancestor.parent);
    }
    const observed = { pid: process.pid, processStart: process.processStart };
    if (custody) retainedProcesses.push({ ...observed, ownerId: custody.ownerId, agentId: custody.agentId, executionId: custody.executionId, custodyPid: custody.pid });
    else oldProcesses.push(observed);
  }
  return { oldProcesses, retainedProcesses, scannedProcesses: processes.size };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const [receipt, rootPid] = process.argv.slice(2);
    if (!receipt || !receipt.startsWith("/") || !/^\d+$/.test(rootPid ?? "")) throw new Error("usage: direct-agent-processes.mjs RETAINED_CUSTODY_RECEIPT GATED_ROOT_PID_OR_ZERO");
    const proof = directAgentProcessProof("/proc", JSON.parse(readFileSync(receipt, "utf8")), Number(rootPid));
    console.log(JSON.stringify(proof));
    if (proof.oldProcesses.length) process.exitCode = 75;
  } catch (error) { console.error(error.message); process.exitCode = 75; }
}
