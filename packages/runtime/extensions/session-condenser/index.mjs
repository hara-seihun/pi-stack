import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  DEFAULT_THRESHOLD,
  activePath,
  buildSegments,
  flattenPath,
  lookupSummaries,
  markVerbatim,
  openSummaryDb,
  parseSession,
  pass1Jobs,
  renderCondensed,
  rowJobs,
  storeSummary,
} from "./condense.mjs";
import { blockPrompt, rowPrompt, thinkingPrompt } from "./prompts.mjs";

const DEFAULT_MODEL = "gpt-5.6-sol";
const SUMMARY_MAX_TOKENS = 2000;
const CALL_TIMEOUT_MS = 240_000;

const dbFile = () =>
  process.env.SESSION_CONDENSER_DB ?? join(homedir(), ".local/share/session-condenser/summaries.sqlite3");

const concurrency = () => {
  const n = Number(process.env.SESSION_CONDENSER_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16;
};

/**
 * Candidate models for summarization, in trial order. The same model id is
 * usually served by several alias providers (multi-account routing), and any
 * of them can be out of usage at a given hour, so the caller walks this list
 * forward on failure instead of dying with the first exhausted account.
 */
function candidateModels(ctx) {
  const modelId = process.env.SESSION_CONDENSER_MODEL ?? DEFAULT_MODEL;
  const provider = process.env.SESSION_CONDENSER_PROVIDER;
  if (provider) {
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`SESSION_CONDENSER_PROVIDER=${provider} has no model ${modelId}`);
    return [model];
  }
  const candidates = ctx.modelRegistry
    .getAll()
    .filter((model) => model.id === modelId && ctx.modelRegistry.hasConfiguredAuth(model));
  const sessionProvider = ctx.model?.provider ?? "";
  candidates.sort((a, b) =>
    (b.provider === sessionProvider) - (a.provider === sessionProvider) || a.provider.localeCompare(b.provider),
  );
  if (candidates.length === 0) throw new Error(`no authenticated provider offers ${modelId}`);
  return candidates;
}

function responseText(response) {
  return (response.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function summarizeBlocks({ ctx, signal, blocks, db, onProgress }) {
  const models = candidateModels(ctx);
  let modelIndex = 0;
  const results = new Map();
  let done = 0;

  const summarizeOne = async (block) => {
    const prompt =
      block.kind === "thinking" ? thinkingPrompt(block.text)
      : block.kind === "row" ? rowPrompt(block.text)
      : blockPrompt(block.text);
    let lastError = "no candidate models";
    while (modelIndex < models.length) {
      const model = models[modelIndex];
      try {
        const response = await ctx.modelRegistry.complete(
          model,
          { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
          {
            maxTokens: SUMMARY_MAX_TOKENS,
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
            cacheRetention: "none",
            sessionId: randomUUID(),
            reasoningEffort: "low",
          },
        );
        const summary = responseText(response);
        if (summary) {
          const record = { summary, model: `${model.provider}/${model.id}` };
          results.set(block.hash, record);
          storeSummary(db, { hash: block.hash, kind: block.kind, chars: block.chars, ...record });
          onProgress?.(++done);
          return;
        }
        lastError = `empty response (stop=${response.stopReason ?? "unknown"})`;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error?.message ?? String(error);
      }
      // This model failed this block; assume the account is the problem
      // (out of usage, rate limited) and move the whole run to the next one.
      modelIndex++;
    }
    modelIndex = models.length - 1;
    results.set(block.hash, { error: lastError });
    onProgress?.(++done);
  };

  const queue = [...blocks];
  const workers = Array.from({ length: Math.min(concurrency(), queue.length) }, async () => {
    for (let block = queue.shift(); block; block = queue.shift()) await summarizeOne(block);
  });
  await Promise.all(workers);
  return results;
}

export default function sessionCondenser(pi) {
  pi.registerTool({
    name: "read_condensed_session",
    label: "Read Condensed Session",
    description:
      "Read a pi session .jsonl file as one hierarchically condensed transcript: long blocks get individual summaries, then every stretch of small blocks between them is compacted into a single prose block written with the condensed neighbors as context. User messages, the assistant replies they answered, and the most recent ten tool calls stay verbatim. Summaries are cached by content hash in a shared database, so re-reading a session only summarizes what is new since last time.",
    promptSnippet: "Read another agent's session with long thinking/tool blocks summarized",
    promptGuidelines: [
      "Use read_condensed_session instead of reading a session .jsonl directly whenever you need to know what another agent did or thought; raw session files are mostly noise at 10-100x the size.",
    ],
    parameters: Type.Object({
      session: Type.String({ description: "Absolute path to a pi session .jsonl file" }),
      threshold: Type.Optional(
        Type.Integer({ description: `Blocks at or over this many characters are summarized (default ${DEFAULT_THRESHOLD})`, minimum: 500 }),
      ),
      output_file: Type.Optional(
        Type.String({ description: "Write the condensed transcript to this file and return only statistics — use for very large sessions" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const threshold = params.threshold ?? DEFAULT_THRESHOLD;
      const raw = readFileSync(params.session, "utf8");
      const entries = parseSession(raw);
      const items = markVerbatim(flattenPath(activePath(entries)));

      const db = openSummaryDb(dbFile());
      try {
        const summaries = new Map();
        let cachedTotal = 0;
        let freshTotal = 0;
        const runWave = async (wave, jobs) => {
          for (const [hash, record] of lookupSummaries(db, jobs.map((job) => job.hash))) summaries.set(hash, record);
          const missing = jobs.filter((job) => !summaries.has(job.hash));
          cachedTotal += jobs.length - missing.length;
          freshTotal += missing.length;
          if (missing.length === 0) return;
          onUpdate?.({
            content: [{ type: "text", text: `${wave}: ${jobs.length - missing.length} of ${jobs.length} cached; summarizing ${missing.length} in parallel...` }],
          });
          const fresh = await summarizeBlocks({
            ctx,
            signal,
            blocks: missing,
            db,
            onProgress: (done) =>
              onUpdate?.({ content: [{ type: "text", text: `${wave}: summarized ${done}/${missing.length}` }] }),
          });
          for (const [hash, record] of fresh) summaries.set(hash, record);
        };

        const p1 = pass1Jobs(items, threshold);
        await runWave("pass 1 (big blocks)", p1);
        const segments = buildSegments(items, threshold, summaries);
        const p2 = rowJobs(segments);
        await runWave("pass 2 (rows)", p2);

        const condensed = renderCondensed(
          segments, threshold, summaries, params.session,
          entries.find((entry) => entry.type === "session"),
        );
        const failed = [...summaries.values()].filter((record) => record.error).length;
        const rows = segments.filter((segment) => segment.type === "row");
        const stats =
          `${raw.length.toLocaleString("en-US")} chars on disk → ${condensed.length.toLocaleString("en-US")} chars condensed · ` +
          `pass 1: ${p1.length} big blocks · pass 2: ${rows.length} rows (${rows.reduce((n, row) => n + row.blocks, 0)} small blocks) · ` +
          `${cachedTotal} cached, ${freshTotal} summarized now${failed ? `, ${failed} FAILED` : ""}`;

        if (params.output_file) {
          writeFileSync(params.output_file, condensed);
          return { content: [{ type: "text", text: `${stats}\nwritten to ${params.output_file}` }] };
        }
        return { content: [{ type: "text", text: `${stats}\n\n${condensed}` }] };
      } finally {
        db.close();
      }
    },
  });
}
