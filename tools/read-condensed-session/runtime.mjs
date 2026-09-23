import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MODEL = "gpt-6-astra";
export const SUMMARY_MAX_TOKENS = 2_000;
export const CALL_TIMEOUT_MS = 240_000;

// Cursor keeps completed HTTP/2 bridges parked for interactive turn reuse. This
// command is one-shot, so a one-hour parked bridge would keep it alive after
// output has been written.
process.env.PI_CURSOR_ACTIVE_BRIDGE_TTL_MS ??= "1000";

let apiPromise;
let runtimePromise;
let bootstrapSession;

function runtimeRoots() {
  const roots = [];
  if (process.env.PI_TOOL_RUNTIME_ROOT) roots.push(process.env.PI_TOOL_RUNTIME_ROOT);
  if (process.env.PI_REMOTE_ORCHESTRATOR_MODULE) roots.push(join(process.env.PI_REMOTE_ORCHESTRATOR_MODULE, ".."));
  roots.push("/srv/pi/pi-orchestrator");
  roots.push(join(homedir(), ".local", "share", "pi-runtime", "current"));
  return [...new Set(roots)];
}

async function codingAgent() {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    const errors = [];
    for (const root of runtimeRoots()) {
      const entry = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
      if (!existsSync(entry)) continue;
      try {
        return await import(pathToFileURL(entry).href);
      } catch (error) {
        errors.push(`${entry}: ${error?.message ?? error}`);
      }
    }
    throw new Error(`cannot load the deployed Pi coding-agent runtime${errors.length ? ` (${errors.join("; ")})` : ""}`);
  })();
  return apiPromise;
}

function agentDir() {
  return process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

async function modelRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const { createAgentSession, SessionManager } = await codingAgent();
    if (!createAgentSession || !SessionManager) throw new Error("deployed Pi runtime lacks session bootstrap APIs");
    const cwd = process.cwd();
    const { session } = await createAgentSession({
      cwd,
      agentDir: agentDir(),
      tools: [],
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      await session.bindExtensions({
        mode: "print",
        onError: ({ extensionPath, error }) => {
          throw new Error(`Pi extension ${extensionPath} failed while loading model providers: ${error?.message ?? error}`);
        },
      });
      // Native providers start their availability refresh without awaiting it.
      // Finish one pass so shared-custody aliases are visible on the first job.
      await session.modelRuntime.refresh({ allowNetwork: false });
      bootstrapSession = session;
      // The bootstrap session loads extension-registered provider aliases and
      // their credentials. Summaries bypass session.prompt and call this
      // runtime directly with one user message.
      return session.modelRuntime;
    } catch (error) {
      session.dispose();
      throw error;
    }
  })();
  return runtimePromise;
}

function parseModel(value) {
  if (!value) return {};
  const slash = value.indexOf("/");
  return slash < 0 ? { modelId: value } : { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export async function candidateModels(runtime, options = {}) {
  const requested = parseModel(options.model ?? process.env.SESSION_CONDENSER_MODEL ?? DEFAULT_MODEL);
  const provider = requested.provider ?? options.provider ?? process.env.SESSION_CONDENSER_PROVIDER;
  const idMatches = (model) => model.id === requested.modelId || model.id.endsWith(`/${requested.modelId}`);
  if (provider) {
    const known = runtime.getModel(provider, requested.modelId) ?? [...runtime.getModels(provider)].find((candidate) => candidate.provider === provider && idMatches(candidate));
    if (!known) throw new Error(`provider ${provider} has no model ${requested.modelId}`);
    const model = [...await runtime.getAvailable(provider)].find((candidate) => candidate.provider === provider && idMatches(candidate));
    if (!model) throw new Error(`provider ${provider} is not authenticated`);
    return [model];
  }

  const candidates = [...await runtime.getAvailable()].filter(idMatches);
  const preferred = options.preferredProvider ?? process.env.PI_PROVIDER ?? "";
  candidates.sort((left, right) =>
    Number(right.provider === preferred) - Number(left.provider === preferred) || left.provider.localeCompare(right.provider),
  );
  if (candidates.length === 0) throw new Error(`no authenticated provider offers ${requested.modelId}`);
  return candidates;
}

function responseText(response) {
  if (!Array.isArray(response?.content)) return "";
  return response.content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

/** Make one bare model request, walking same-model provider aliases on failure. */
export async function summarizeWithRuntime(runtime, prompt, options = {}) {
  const candidates = await candidateModels(runtime, options);
  const errors = [];
  for (const model of candidates) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await runtime.complete(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        {
          maxTokens: options.maxTokens ?? SUMMARY_MAX_TOKENS,
          signal,
          cacheRetention: "none",
          sessionId: randomUUID(),
          reasoningEffort: options.thinking ?? "low",
        },
      );
      if (response?.stopReason === "error") throw new Error(response.errorMessage ?? "model returned an error");
      if (response?.stopReason === "aborted") throw new Error("model request was aborted");
      const text = responseText(response);
      if (!text) throw new Error(`empty response (stop=${response?.stopReason ?? "unknown"})`);
      return { text, model: `${model.provider}/${model.id}` };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      errors.push(`${model.provider}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`all providers failed for ${candidates[0].id}: ${errors.join("; ")}`);
}

export async function summarizeDirect(prompt, options = {}) {
  return summarizeWithRuntime(await modelRuntime(), prompt, options);
}

export async function disposeModelRuntime() {
  if (runtimePromise) {
    try { await runtimePromise; } catch {}
  }
  bootstrapSession?.dispose();
  bootstrapSession = undefined;
  runtimePromise = undefined;
}
