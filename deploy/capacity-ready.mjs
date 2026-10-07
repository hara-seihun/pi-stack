#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export async function requireCapacityReady(status) {
  const receipt = await status();
  if (!receipt.ok) throw new Error(receipt.error.message);
  if (receipt.value.authority !== "pi-stack-global-agents-v1" || receipt.value.limit !== 100 || receipt.value.initialized !== true
    || !Number.isSafeInteger(receipt.value.active) || receipt.value.active < 0 || receipt.value.active > 100) {
    throw new Error("Global agent capacity cutover incomplete; finish deploy/capacity-bootstrap before model doctors or fresh admission");
  }
  return receipt.value;
}
export async function requireCapacityUninitialized(status) {
  const receipt = await status();
  if (!receipt.ok) throw new Error(receipt.error.message);
  if (receipt.value.authority !== "pi-stack-global-agents-v1" || receipt.value.limit !== 100 || receipt.value.initialized !== false || receipt.value.active !== 0) {
    throw new Error("First-cutover host gate requires reachable, uninitialized shared authority with zero leases");
  }
  return receipt.value;
}
async function main(args) {
  const uninitialized = args.length === 2 && args[0] === "uninitialized";
  const modulePath = uninitialized ? args[1] : args[0];
  if (!(args.length === 1 || uninitialized) || !isAbsolute(modulePath)) throw new Error("Usage: node deploy/capacity-ready.mjs [uninitialized] /absolute/orchestrator/dist/agent-capacity.js");
  const { configuredAgentCapacityStatus } = await import(pathToFileURL(modulePath).href);
  const status = () => configuredAgentCapacityStatus();
  console.log(JSON.stringify(await (uninitialized ? requireCapacityUninitialized(status) : requireCapacityReady(status))));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 75; });
