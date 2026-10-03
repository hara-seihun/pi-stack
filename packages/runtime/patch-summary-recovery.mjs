import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helper = readFileSync(new URL("./bounded-summary.js", import.meta.url), "utf8").replace("export async function", "async function");

export function patchSummaryRecovery(source) {
  const marker = "/* Pi Stack bounded summary recovery */";
  if (source.includes(marker)) return source;
  const pattern = /(?:export )?async function completeSummarization\(model,\s*context,\s*options,\s*streamFn,\s*retry,\s*callbacks\)/;
  const match = source.match(pattern);
  if (!match) throw new Error("Pinned Pi summarization request boundary changed");
  const renamed = match[0].replace("export ", "").replace("completeSummarization(", "completeSummarizationOnce(");
  source = source.replace(pattern, renamed);
  const wrapper = `${marker}\n${helper}\n${match[0]} { return boundedSummarization(model, context, options, (nextContext, nextOptions) => completeSummarizationOnce(model, nextContext, nextOptions, streamFn, retry, callbacks), combineUsage); }\n`;
  return source.slice(0, match.index) + wrapper + source.slice(match.index);
}

export function patchSummaryFailureFence(source) {
  const marker = "/* Pi Stack durable summary failure fence */";
  if (source.includes(marker)) return source;
  const insertion = source.search(/_installAgentRequestProjection\(\)\s*\{/);
  if (insertion < 0) throw new Error("Pinned Pi request projection boundary changed");
  const method = `${marker}
  _assertSummaryRecovery() {
    if (!this.model || this.model.api === "openai-codex-responses") return;
    const modelKey = this.model.api + "/" + this.model.id;
    for (const entry of this.sessionManager.getBranch().slice().reverse()) {
      if (entry.type === "compaction") return;
      if (entry.type === "custom" && entry.customType === "pi-stack-auto-compaction-failure" && entry.data?.modelKey === modelKey) {
        throw new Error("Context rejected: " + entry.data.error + ". Context is unchanged. Automatic resubmission is blocked; retry with /compact or compact RPC, or switch model.");
      }
    }
  }
  `;
  source = source.slice(0, insertion) + method + source.slice(insertion);
  const request = /this\.agent\.prepareRequest\s*=\s*async\s*\(request,\s*signal\)\s*=>\s*\{/g;
  if ([...source.matchAll(request)].length !== 1) throw new Error("Pinned Pi provider preparation changed");
  source = source.replace(request, match => `${match} this._assertSummaryRecovery();`);
  const start = source.indexOf("async _runAutoCompaction(");
  const end = source.indexOf("setAutoCompactionEnabled(", start);
  if (start < 0 || end < 0) throw new Error("Pinned Pi auto-compaction boundary changed");
  let methodSource = source.slice(start, end);
  const tryBoundary = /\btry\s*\{/g;
  if ([...methodSource.matchAll(tryBoundary)].length !== 1) throw new Error("Pinned Pi auto-compaction failure boundary changed");
  methodSource = methodSource.replace(tryBoundary, match => `${match} this._assertSummaryRecovery();`);
  const aborted = /\baborted\s*=\s*abortController\?\.signal\.aborted\s*===\s*(?:true|!0)\s*\|\|\s*cancelledByExtension;?/g;
  if ([...methodSource.matchAll(aborted)].length !== 1) throw new Error("Pinned Pi auto-compaction cancellation changed");
  methodSource = methodSource.replace(aborted, match => `${match}; if (!aborted && model && model.api !== "openai-codex-responses" && !message.startsWith("Context rejected:")) this.sessionManager.appendCustomEntry("pi-stack-auto-compaction-failure", { modelKey: model.api + "/" + model.id, error: message, reason });`);
  return source.slice(0, start) + methodSource + source.slice(end);
}

export function patchSummaryRecoveryCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const chunks = join(base, "bundle/chunks");
  const paths = [join(base, "core/compaction/compaction.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async function completeSummarization("))];
  if (paths.length !== 2) throw new Error(`Expected two Pi summarization consumers, found ${paths.length}`);
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    const patched = patchSummaryRecovery(source);
    if (source !== patched) writeFileSync(path, patched);
  }
  const sessions = [join(base, "core/agent-session.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async _runAutoCompaction("))];
  if (sessions.length !== 2) throw new Error(`Expected two Pi auto-compaction consumers, found ${sessions.length}`);
  for (const path of sessions) {
    const source = readFileSync(path, "utf8");
    const patched = patchSummaryFailureFence(source);
    if (source !== patched) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-summary-recovery.mjs NODE_MODULES");
  patchSummaryRecoveryCopies(resolve(process.argv[2]));
}
