import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { chooseInteractiveAccount } from "./auth/account-selection.js";
import { providerOAuth, type SharedOAuthAuth } from "./auth/shared-oauth.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { IMAGE_MODELS, IMAGE_QUALITIES, IMAGE_SIZES, PNG_SIGNATURE, requestImage, type ImageAuth, type ImageFailure, type ImageRequest, type ImageResult } from "./image-generation.js";

export type SharedImageInput = Omit<ImageRequest, "images"> & { inputPaths?: readonly string[] };
export type SharedImageFailure = ImageFailure | { kind: "invalid-input" | "unavailable" | "authentication" | "storage" | "closed"; message: string };
export type SharedImageResult = Extract<ImageResult, { ok: true }> | { ok: false; error: SharedImageFailure };
export type ImageGenerationOptions = { signal?: AbortSignal; cwd?: string };
export type SharedImageAccountOwner = { store: Store; shared: SharedOAuthAuth | undefined };
export type SharedImageServiceOptions = { configPath?: string; ledgerPath?: string; authPath?: string };
export interface SharedImageGenerationService {
  generateImageWithSharedAccount(input: SharedImageInput, options?: ImageGenerationOptions): Promise<SharedImageResult>;
  close(): Promise<void>;
}
type Result<T> = { ok: true; value: T } | { ok: false; error: SharedImageFailure };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const cancelled = (): SharedImageResult & { ok: false } => ({ ok: false, error: { kind: "cancelled", message: "Image generation cancelled or exceeded its five-minute deadline. No automatic retry was made." } });

export function imagePath(path: string, cwd: string) {
  path = path.replace(/^@/, "");
  return resolve(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

export async function loadImageInputs(input: SharedImageInput, cwd: string, signal: AbortSignal): Promise<Result<string[]>> {
  if (signal.aborted) return cancelled();
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32000) {
    return { ok: false, error: { kind: "invalid-input", message: "Image prompt must contain 1 to 32000 characters and cannot be blank." } };
  }
  if ((input.model !== undefined && !IMAGE_MODELS.includes(input.model)) ||
      (input.quality !== undefined && !IMAGE_QUALITIES.includes(input.quality)) ||
      (input.size !== undefined && !IMAGE_SIZES.includes(input.size))) {
    return { ok: false, error: { kind: "invalid-input", message: "Unsupported image model, quality or size." } };
  }
  const paths = input.inputPaths ?? [];
  if (!Array.isArray(paths) || paths.length > 16 || paths.some(path => typeof path !== "string" || !path.length)) {
    return { ok: false, error: { kind: "invalid-input", message: "Image inputs must be at most 16 nonempty local paths." } };
  }
  try {
    const images: string[] = [];
    let total = 0;
    for (const path of paths) {
      signal.throwIfAborted();
      const absolute = imagePath(path, cwd);
      const info = await stat(absolute);
      if (!info.isFile()) return { ok: false, error: { kind: "invalid-input", message: `Image input is not a file: ${path}` } };
      if (info.size + total > 32 * 1024 * 1024) return { ok: false, error: { kind: "invalid-input", message: "Image inputs exceed 32 MiB." } };
      const bytes = await readFile(absolute, { signal });
      total += bytes.length;
      if (total > 32 * 1024 * 1024) return { ok: false, error: { kind: "invalid-input", message: "Image inputs exceed 32 MiB." } };
      const mime = bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
      if (!mime) return { ok: false, error: { kind: "invalid-input", message: `Unsupported image input: ${path}` } };
      images.push(`data:${mime};base64,${bytes.toString("base64")}`);
    }
    return { ok: true, value: images };
  } catch (error) {
    return signal.aborted ? cancelled() : { ok: false, error: { kind: "invalid-input", message: `Cannot read image input: ${message(error)}` } };
  }
}

export function imageAuth(auth: ModelAuth | undefined, kind: ImageAuth["kind"], accountId?: unknown): Result<ImageAuth> {
  try {
    if (!auth?.apiKey) return { ok: false, error: { kind: "authentication", message: "OpenAI authentication is unavailable. Connect an OpenAI account and reload Pi." } };
    const headers = new Headers();
    for (const [key, value] of Object.entries(auth.headers ?? {})) if (typeof value === "string") headers.set(key, value);
    headers.set("Authorization", `Bearer ${auth.apiKey}`);
    if (kind === "codex" && !headers.has("chatgpt-account-id")) {
      accountId ??= JSON.parse(Buffer.from(auth.apiKey.split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof accountId !== "string" || !accountId) return { ok: false, error: { kind: "authentication", message: "OpenAI Codex authentication has no ChatGPT account ID." } };
      headers.set("chatgpt-account-id", accountId);
    }
    return { ok: true, value: { kind, headers } };
  } catch (error) {
    return { ok: false, error: { kind: "authentication", message: `OpenAI authentication failed: ${message(error)}` } };
  }
}

export async function generateImageWithSharedAccount(input: SharedImageInput, options: SharedImageAccountOwner & ImageGenerationOptions): Promise<SharedImageResult> {
  const { store, shared } = options;
  const heartbeatFailure = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(300_000), heartbeatFailure.signal, ...(options.signal ? [options.signal] : [])]);
  let lease: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let result: SharedImageResult;
  let phase: "storage" | "authentication" = "storage";
  try {
    const inputs = await loadImageInputs(input, options.cwd ?? process.cwd(), signal);
    if (!inputs.ok) return inputs;
    if (signal.aborted) return cancelled();
    const account = store.transaction(() => {
      const account = chooseInteractiveAccount(store, shared, "openai-codex");
      if (account) {
        const id = `interactive:image:${crypto.randomUUID()}`;
        store.createLease(id, account.id, "interactive");
        lease = id;
      }
      return account;
    });
    if (!account) return { ok: false, error: { kind: "unavailable", message: "Image generation requires a connected, eligible OpenAI account." } };
    timer = setInterval(() => {
      try { store.heartbeatLease(lease!); }
      catch (error) { heartbeatFailure.abort(error); }
    }, 30_000);
    phase = "authentication";
    const credential = await shared!.credential(account.id, signal);
    const auth = imageAuth({ apiKey: credential.access }, "codex", credential.accountId);
    if (!auth.ok) result = auth;
    else {
      phase = "storage";
      result = await requestImage({ ...input, images: inputs.value }, auth.value, signal);
      if (!result.ok && result.error.kind === "http" && result.error.status === 429) {
        store.setCooldown(account.id, Date.now() + (result.error.retryAfterMs ?? 60_000));
      }
    }
  } catch (error) {
    result = signal.aborted ? cancelled() : { ok: false, error: { kind: phase, message: message(error) } };
  } finally {
    clearInterval(timer);
    if (lease) store.endLease(lease);
  }
  if (heartbeatFailure.signal.aborted && !result.ok) {
    return { ok: false, error: { kind: "storage", message: `Image lease heartbeat failed: ${message(heartbeatFailure.signal.reason)}` } };
  }
  return result;
}

export function createSharedImageGenerationService(options: SharedImageServiceOptions | SharedImageAccountOwner = {}): SharedImageGenerationService {
  let owner: SharedImageAccountOwner;
  let ownsStore = false;
  if ("store" in options) owner = options;
  else {
    const ledgerPath = options.ledgerPath ?? process.env.PI_ORCHESTRATOR_LEDGER ?? join(homedir(), ".local/share/pi-orchestrator/ledger.sqlite3");
    const config = loadConfig(options.configPath, ledgerPath);
    const family = builtinProviders().find(provider => provider.id === "openai-codex");
    if (!family) throw new Error("OpenAI Codex provider is missing from the runtime");
    const shared = providerOAuth(family, options.authPath ?? config.authPath);
    owner = { store: Store.open(ledgerPath), shared };
    ownsStore = true;
  }
  const shutdown = new AbortController();
  const active = new Set<Promise<SharedImageResult>>();
  let closing: Promise<void> | undefined;
  return {
    generateImageWithSharedAccount(input, options = {}) {
      if (shutdown.signal.aborted) return Promise.resolve({ ok: false, error: { kind: "closed", message: "Image generation service is closed." } });
      const signal = AbortSignal.any([shutdown.signal, ...(options.signal ? [options.signal] : [])]);
      const request = generateImageWithSharedAccount(input, { ...options, ...owner, signal });
      active.add(request);
      const forget = () => { active.delete(request); };
      void request.then(forget, forget);
      return request;
    },
    close() {
      if (!closing) {
        shutdown.abort();
        closing = (async () => {
          const results = await Promise.allSettled(active);
          if (ownsStore) owner.store.close();
          const failed = results.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        })();
      }
      return closing;
    },
  };
}
