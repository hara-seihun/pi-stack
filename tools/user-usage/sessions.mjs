import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const COMPONENTS = ["input", "output", "cacheRead", "cacheWrite"];
export const emptyTokens = () => Object.fromEntries(COMPONENTS.map(k => [k, 0]));
export const familyOf = provider => /^(openai-codex|anthropic)(-\d+)?$/.exec(provider)?.[1] ?? provider;

async function* files(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && path.endsWith(".jsonl")) yield path;
  }
}

async function* lines(path) {
  let pending = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    pending += chunk;
    let start = 0, end;
    while ((end = pending.indexOf("\n", start)) !== -1) {
      yield { text: pending.slice(start, end), tail: false };
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (pending.trim()) yield { text: pending, tail: true };
}

export async function scanSessions(root, since, until) {
  const report = { files: 0, responses: 0, duplicates: 0, incompleteTails: 0, missingUsage: 0,
    firstAt: null, lastAt: null, tokens: emptyTokens(), totalTokens: 0, loggedApiUsd: 0,
    unpricedResponses: 0, models: [] };
  const models = new Map(), seen = new Set();
  try {
    for await (const path of files(root)) {
      report.files++;
      let lineNumber = 0;
      for await (const { text, tail } of lines(path)) {
        lineNumber++;
        if (!text.trim()) continue;
        let entry;
        try { entry = JSON.parse(text); }
        catch {
          if (tail) { report.incompleteTails++; continue; }
          return { ok: false, error: `Malformed JSON at ${path}:${lineNumber}` };
        }
        const message = entry.message;
        if (entry.type !== "message" || message?.role !== "assistant") continue;
        const at = Date.parse(entry.timestamp);
        if (!Number.isFinite(at)) return { ok: false, error: `Missing timestamp at ${path}:${lineNumber}` };
        if (at < since || at >= until) continue;
        // Forks copy entries. Count every branch's actual calls, but each copied entry only once.
        const hash = createHash("sha256").update(JSON.stringify([entry.id, entry.timestamp, message])).digest("hex");
        if (seen.has(hash)) { report.duplicates++; continue; }
        seen.add(hash);
        const usage = message.usage;
        if (!usage) { report.missingUsage++; continue; }
        const tokens = {};
        for (const k of COMPONENTS) {
          const n = usage[k] ?? 0;
          if (!Number.isFinite(n) || n < 0) return { ok: false, error: `Invalid ${k} tokens at ${path}:${lineNumber}` };
          tokens[k] = n;
        }
        const total = Object.values(tokens).reduce((a, b) => a + b, 0);
        if (total === 0) continue;
        const provider = familyOf(message.provider ?? "unknown"), model = message.model ?? "unknown";
        const key = JSON.stringify([provider, model]);
        if (!models.has(key)) models.set(key, { provider, model, responses: 0, tokens: emptyTokens(),
          totalTokens: 0, loggedApiUsd: 0, pricedTokens: emptyTokens(), componentUsd: emptyTokens(), unpricedResponses: 0 });
        const row = models.get(key);
        row.responses++; report.responses++;
        row.totalTokens += total; report.totalTokens += total;
        for (const k of COMPONENTS) { row.tokens[k] += tokens[k]; report.tokens[k] += tokens[k]; }
        const cost = usage.cost;
        if (cost && Number.isFinite(cost.total) && cost.total >= 0 &&
            COMPONENTS.every(k => Number.isFinite(cost[k]) && cost[k] >= 0) && cost.total > 0) {
          row.loggedApiUsd += cost.total; report.loggedApiUsd += cost.total;
          for (const k of COMPONENTS) { row.pricedTokens[k] += tokens[k]; row.componentUsd[k] += cost[k]; }
        } else { row.unpricedResponses++; report.unpricedResponses++; }
        report.firstAt = report.firstAt === null ? at : Math.min(report.firstAt, at);
        report.lastAt = report.lastAt === null ? at : Math.max(report.lastAt, at);
      }
    }
    report.models = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    return { ok: true, value: report };
  } catch (error) {
    return { ok: false, error: `Cannot read sessions at ${root}: ${String(error)}` };
  }
}
