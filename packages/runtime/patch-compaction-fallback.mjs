import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const methods = `
    /* Pi Stack single alternate compaction */
    /* Pi Stack compaction failure propagation */
    async _runCompactionWithFallback(model, preparation, pathEntries, customInstructions, signal, reason, willRetry) {
        return runCompactionWithFallback({
            model, signal,
            availableModels: () => this._modelRuntime.getAvailableSnapshot(),
            record: data => this.sessionManager.appendCustomEntry("pi-stack-compaction-fallback", { ...data, reason, at: Date.now() }),
            primary: async () => {
                const auth = await this._getSummarizationRequestAuth(model, signal);
                signal.throwIfAborted();
                if (this._extensionRunner.hasHandlers("session_before_compact")) {
                    const result = await this._extensionRunner.emit({ type: "session_before_compact", preparation,
                        branchEntries: pathEntries, customInstructions, reason, willRetry, signal });
                    if (result?.error) throw Object.assign(new Error(result.error), { compactionFromExtension: true });
                    if (result?.cancel) return { state: "cancelled" }; 
                    if (result?.compaction) return { state: "ready", value: result.compaction, fromExtension: true, model: this.model };
                }
                signal.throwIfAborted();
                const value = await this._runDefaultCompaction(preparation, auth.model, auth.apiKey, auth.headers,
                    customInstructions, signal, auth.env, reason);
                return { state: "ready", value, fromExtension: false, model: auth.model };
            },
            fallback: async alternate => {
                const portable = portableCompactionPreparation(preparation, pathEntries, buildSessionProjection);
                if (!portable.ok) throw Object.assign(new Error(portable.error.message), { code: portable.error.code });
                // Alternate prose must not inherit original-model native checkpoint/header hooks.
                return compact(portable.value, alternate, undefined, undefined, customInstructions, signal,
                    undefined, this._modelRuntime.streamSimple.bind(this._modelRuntime), undefined,
                    this.settingsManager.getRetrySettings(), this._summarizationRetryCallbacks({ source: "compaction", reason }), undefined);
            },
        });
    }
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Pinned Pi compaction fallback boundary changed: ${before}`);
  return source.replace(before, after);
}

function callAttempt(signal, instructions, reason, retry) {
  return `const attempt = await this._runCompactionWithFallback(model, preparation, pathEntries, ${instructions}, ${signal}, ${reason}, ${retry});
            fromExtension = attempt.fromExtension === true;
            if (attempt.state !== "ready") {
                cancelledByExtension = attempt.state === "cancelled";
                throw attempt.error instanceof Error ? attempt.error : new Error(attempt.error?.message ?? "Compaction cancelled");
            }
            const { summary, firstKeptEntryId, tokensBefore, usage, details } = attempt.value;
            `;
}

export function patchCompactionFallback(source) {
  if (source.includes("/* Pi Stack single alternate compaction */")) return source;
  if (!source.includes("Pi Stack compaction failure propagation") || !source.includes("Pi Stack durable summary failure fence")) {
    throw new Error("Compaction fallback requires failure propagation and summary recovery patches first");
  }
  source = 'import { runCompactionWithFallback } from "./compaction-fallback.js";\nimport { portableCompactionPreparation } from "./compaction-fallback-history.js";\nimport { buildSessionProjection } from "./session-manager.js";\n' + source;
  source = replaceOnce(source, "    async _runDefaultCompaction(", methods + "    async _runDefaultCompaction(");
  const manualStart = source.indexOf("async compact(customInstructions)");
  const manualEnd = source.indexOf("async _checkCompaction(", manualStart);
  if (manualStart < 0 || manualEnd < 0) throw new Error("Pinned Pi manual compaction method changed");
  let manual = source.slice(manualStart, manualEnd);
  manual = replaceOnce(manual, "            const { model: requestModel, apiKey, headers, env, } = await this._getSummarizationRequestAuth(model, this._compactionAbortController.signal);\n", "");
  const start = manual.indexOf("            let extensionCompaction;");
  const end = manual.indexOf("            if (this._compactionAbortController.signal.aborted)", start);
  if (start < 0 || end < 0) throw new Error("Pinned Pi manual compaction attempt changed");
  manual = manual.slice(0, start) + "            " + callAttempt("this._compactionAbortController.signal", "customInstructions", '"manual"', "false") + manual.slice(end).trimStart();
  source = source.slice(0, manualStart) + manual + source.slice(manualEnd);
  const autoStart = source.indexOf("async _runAutoCompaction(");
  const autoEnd = source.indexOf("setAutoCompactionEnabled(", autoStart);
  if (autoStart < 0 || autoEnd < 0) throw new Error("Pinned Pi automatic compaction method changed");
  let auto = source.slice(autoStart, autoEnd);
  const a = auto.indexOf("            const { model: requestModel, apiKey, headers, env, } = await this._getSummarizationRequestAuth(");
  const b = auto.indexOf("            this.sessionManager.appendCompaction(", a);
  if (a < 0 || b < 0) throw new Error("Pinned Pi automatic compaction attempt changed");
  auto = auto.slice(0, a) + "            " + callAttempt("abortController.signal", "undefined", "reason", "willRetry") + "abortController.signal.throwIfAborted();\n" + auto.slice(b);
  return source.slice(0, autoStart) + auto + source.slice(autoEnd);
}

export function patchCompactionFallbackCopies(nodeModules) {
  const core = join(nodeModules, "@earendil-works/pi-coding-agent/dist/core");
  for (const name of ["compaction-fallback.js", "compaction-fallback-history.js"]) {
    writeFileSync(join(core, name), readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
  }
  const target = join(core, "agent-session.js");
  writeFileSync(target, patchCompactionFallback(readFileSync(target, "utf8")));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-compaction-fallback.mjs NODE_MODULES");
  patchCompactionFallbackCopies(resolve(process.argv[2]));
}
