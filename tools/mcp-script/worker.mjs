import { parentPort, workerData } from "node:worker_threads";

const pending = new Map();
let nextId = 1;

function request(method, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "request", id, method, args });
  });
}

parentPort.on("message", (message) => {
  if (message.type !== "response") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new Error(message.error?.message ?? "MCP script request failed"));
});

const builtins = {
  search: (args = {}) => request("search", args),
  describe: (args = {}) => request("describe", args),
  call: (path, args = {}) => request("call", { path, args }),
  status: (args = {}) => request("status", args),
  list: (args = {}) => request("list", args),
  instructions: (args = {}) => request("instructions", args),
  connect: (args = {}) => request("connect", args),
};

const tools = new Proxy(builtins, {
  get(target, property) {
    if (typeof property !== "string") return target[property];
    if (property in target) return target[property];
    return (args = {}) => request("call", { path: property, args });
  },
});

const emitted = [];
const emit = (value) => {
  emitted.push(value);
  parentPort.postMessage({ type: "emit", value });
};

try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("tools", "emit", `"use strict";\n${workerData.code}\n`);
  const result = await run(tools, emit);
  parentPort.postMessage({ type: "done", result, emitted });
} catch (error) {
  parentPort.postMessage({ type: "failed", error: { message: error?.message ?? String(error), stack: error?.stack } });
}
