// Thread naming through a local OpenAI-compatible engine listed in the agent directory's
// local-models.json, the same host manifest the runtime's local-models extension registers. The
// supervisor probes the engine, starts it as the manifest's transient user unit when it is down, and
// asks it for a title without thinking. Nothing here touches the shared account pool or the ledger.
//
// An engine whose manifest entry declares a maintenance reservation is probed, started and asked under
// that reservation's shared lock, so a benchmark holding it exclusively keeps the engine paused and
// naming defers until the lease ends.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEngineReservation, withEngineReservation, type EngineReservation } from "./engine-reservation";

export interface LocalEngine {
  id: string;
  baseUrl: string;
  apiKey: string;
  reservation?: EngineReservation;
  start?: { unit: string; command: string[]; cwd?: string; readySeconds: number };
}

export async function loadLocalEngine(agentDir: string, engineId: string, environment = process.env): Promise<LocalEngine> {
  const path = environment.PI_STACK_LOCAL_MODELS || join(agentDir, "local-models.json");
  let raw: any;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read local engine manifest ${path}: ${(error as Error).message}`); }
  const engine = Array.isArray(raw?.engines) ? raw.engines.find((candidate: any) => candidate?.id === engineId) : undefined;
  if (!engine || typeof engine.baseUrl !== "string") throw new Error(`Local engine ${engineId} is not listed in ${path}`);
  const start = engine.start && Array.isArray(engine.start.command) && engine.start.command.length > 0 ? {
    command: engine.start.command as string[],
    unit: typeof engine.start.unit === "string" && engine.start.unit ? engine.start.unit : `local-model-${engineId}`,
    cwd: typeof engine.start.cwd === "string" ? engine.start.cwd : undefined,
    readySeconds: Number.isFinite(engine.start.readySeconds) && engine.start.readySeconds > 0 ? engine.start.readySeconds : 120,
  } : undefined;
  return { id: engineId, baseUrl: engine.baseUrl.replace(/\/+$/u, ""), apiKey: typeof engine.apiKey === "string" && engine.apiKey ? engine.apiKey : "local",
    reservation: parseEngineReservation(engine.reservation, engineId), start };
}

/**
 * Hold the engine's maintenance reservation for one naming attempt: probing, any start, and the
 * completion itself. Throws `EngineReservedError` when a maintenance holder has the engine.
 */
export function withLocalEngine<T>(engine: LocalEngine, waitSeconds: number, work: () => Promise<T>, spawnImpl = spawn): Promise<T> {
  return withEngineReservation(engine.id, engine.reservation, waitSeconds, work, spawnImpl);
}

async function reachable(baseUrl: string, fetchImpl: typeof fetch, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

function launch(engine: LocalEngine): Promise<void> {
  const start = engine.start!;
  const args = ["--user", "--collect", "--quiet", `--unit=${start.unit}`, ...(start.cwd ? [`--working-directory=${start.cwd}`] : []), "--", ...start.command];
  return new Promise((resolve, reject) => {
    const child = spawn("systemd-run", args, { stdio: "ignore" });
    child.on("error", (error) => reject(new Error(`cannot spawn systemd-run for ${engine.id}: ${error.message}`)));
    // A non-zero exit usually means the unit already exists; the readiness poll decides.
    child.on("exit", () => resolve());
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Make sure the engine answers, starting its unit when it is down. */
export async function ensureLocalEngine(engine: LocalEngine, fetchImpl: typeof fetch = fetch, pollMs = 1000): Promise<void> {
  if (await reachable(engine.baseUrl, fetchImpl)) return;
  if (!engine.start) throw new Error(`Local engine ${engine.id} is not answering at ${engine.baseUrl} and has no start command`);
  await launch(engine);
  const deadline = Date.now() + engine.start.readySeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await reachable(engine.baseUrl, fetchImpl)) return;
  }
  throw new Error(`Local engine ${engine.id} (unit ${engine.start.unit}) did not answer within ${engine.start.readySeconds} s`);
}

export interface LocalNamingRequest {
  model: string;
  systemPrompt: string;
  prompt: string;
  reasoningEffort: "none" | "low" | "medium" | "xhigh";
  maxTokens: number;
}

/** One non-streaming chat completion; returns the assistant text. */
export async function localNamingCompletion(engine: LocalEngine, request: LocalNamingRequest, fetchImpl: typeof fetch = fetch, timeoutMs = 120_000): Promise<string> {
  const response = await fetchImpl(`${engine.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${engine.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: request.model,
      stream: false,
      reasoning_effort: request.reasoningEffort,
      max_tokens: request.maxTokens,
      temperature: 0,
      messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: request.prompt }],
    }),
  });
  const body: any = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`Local engine ${engine.id} answered ${response.status}: ${body?.error?.message ?? response.statusText}`);
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error(`Local engine ${engine.id} returned no message content`);
  return text;
}
