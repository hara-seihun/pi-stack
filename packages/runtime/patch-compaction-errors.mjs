import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function replaceOnce(source, before, after) {
  const count = typeof before === "string" ? source.split(before).length - 1 : [...source.matchAll(before)].length;
  if (count !== 1) throw new Error(`Pinned Pi failure boundary changed: ${before}`);
  return source.replace(before, after);
}

export function patchCompactionErrors(source) {
  if (source.includes("Pi Stack compaction failure propagation")) return source;
  source = source.replace(/if \((result|extensionResult)\?\.error\) \{ \/\* Pi Stack compaction error result \*\/ fromExtension = true; (?:this\.agent\.abort\(\); )?throw new Error\(\1\.error\); \}\n/g, "");
  for (const [variable, automatic] of [["result", false], ["extensionResult", true]]) {
    const pattern = new RegExp(`if\\s*\\(\\s*${variable}\\?\\.cancel\\s*\\)`, "g");
    const matches = [...source.matchAll(pattern)];
    const start = source.indexOf(automatic ? "async _runAutoCompaction(" : "async compact(customInstructions)");
    const match = matches.find(match => match.index > start);
    if (start < 0 || !match) throw new Error("Pinned Pi compaction result boundary changed");
    const insertion = `if (${variable}?.error) { /* Pi Stack compaction failure propagation */ fromExtension = true; throw new Error(${variable}.error); }\n`;
    source = source.slice(0, match.index) + insertion + source.slice(match.index);
  }
  const prepareStart = source.indexOf("async _compactBeforeNextAssistantResponse(");
  const prepareEnd = source.indexOf("_installAgentNextTurnRefresh(", prepareStart);
  if (prepareStart < 0 || prepareEnd < 0) throw new Error("Pinned Pi next-turn preparation changed");
  const prepare = replaceOnce(source.slice(prepareStart, prepareEnd), /await this\._runAutoCompaction\("threshold",\s*(?:false|!1)\)/g, 'await this._runAutoCompaction("threshold", false, true)');
  source = source.slice(0, prepareStart) + prepare + source.slice(prepareEnd);
  source = replaceOnce(source, /async _runAutoCompaction\(reason,\s*willRetry\)\s*\{/g, "async _runAutoCompaction(reason, willRetry, propagateFailure = false) {");
  const start = source.indexOf("async _runAutoCompaction(");
  const end = source.indexOf("setAutoCompactionEnabled(", start);
  let method = source.slice(start, end);
  const errorName = method.match(/(?:const|let) (\w+)\s*=\s*error instanceof Error\s*\?\s*error\.message\s*:\s*"compaction failed"/)?.[1];
  if (!errorName) throw new Error("Pinned Pi compaction error binding changed");
  method = replaceOnce(method, /return\s*(?:!1|false);?\s*}\s*finally\s*{/g, match => `if (aborted) return false; const failure = new Error(\`Auto-compaction failed: \${${errorName}}\`); if (propagateFailure) throw failure; await this.agent.runWithLifecycle(async () => { await this.agent.processEvents({ type: "agent_start" }); throw failure; }); ${match}`);
  source = source.slice(0, start) + method + source.slice(end);
  const rejectTerminal = (match, message) => `${match}\n        if (/^(?:Context rejected:|Auto-compaction failed:|Context overflow recovery failed:)/.test(${message}.errorMessage ?? "")) return false;`;
  source = replaceOnce(source, /_isRetryableError\((\w+)\)\s*{/g, rejectTerminal);
  return replaceOnce(source, /async _checkCompaction\((\w+),\s*skipAbortedCheck\s*=\s*(?:true|!0)(?:,\s*toolResults\s*=\s*\[\])?\)\s*{/g, rejectTerminal);
}

export function patchContextErrors(source) {
  if (source.includes("Pi Stack context rejection result")) return source;
  const start = source.indexOf("async emitContext(messages)");
  const end = source.indexOf("async emitBeforeProviderRequest(", start);
  if (start < 0 || end < 0 || !source.slice(start, end).includes("return currentMessages")) throw new Error("Pinned Pi context handler boundary changed");
  const method = `async emitContext(messages) {
    /* Pi Stack context rejection result */
    const ctx = this.createContext();
    let currentMessages = structuredClone(messages);
    for (const ext of this.extensions) {
      for (const handler of ext.handlers.get("context") ?? []) {
        let result;
        try { result = await handler({ type: "context", messages: currentMessages }, ctx); }
        catch (error) {
          this.emitError({ extensionPath: ext.path, event: "context", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
          continue;
        }
        if (result?.error) throw new Error(\`Context rejected: \${result.error}\`);
        if (result?.messages) currentMessages = result.messages;
      }
    }
    return currentMessages;
  }
  `;
  return source.slice(0, start) + method + source.slice(end);
}

export function patchCompactionErrorCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const chunks = join(base, "bundle/chunks");
  const bundled = readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name));
  for (const [file, marker, patch] of [
    ["core/agent-session.js", "async _runAutoCompaction(", patchCompactionErrors],
    ["core/extensions/runner.js", "async emitContext(messages)", patchContextErrors],
  ]) {
    const paths = [join(base, file), ...bundled.filter(path => readFileSync(path, "utf8").includes(marker))];
    if (paths.length !== 2) throw new Error(`Expected two Pi failure consumers for ${file}, found ${paths.length}`);
    for (const path of paths) {
      const source = readFileSync(path, "utf8"), patched = patch(source);
      if (source !== patched) writeFileSync(path, patched);
    }
  }
  const types = join(base, "core/extensions/types.d.ts");
  let declaration = readFileSync(types, "utf8");
  for (const name of ["SessionBeforeCompactResult", "ContextEventResult"]) {
    const marker = `export interface ${name} {`;
    if (!declaration.includes(marker)) throw new Error(`Pinned Pi ${name} type changed`);
    if (!declaration.includes(`${marker}\n    error?: string;`)) declaration = declaration.replace(marker, `${marker}\n    error?: string;`);
  }
  writeFileSync(types, declaration);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-compaction-errors.mjs NODE_MODULES");
  patchCompactionErrorCopies(resolve(process.argv[2]));
}
