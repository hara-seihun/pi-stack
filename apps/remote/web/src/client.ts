import { API } from "../../server/api";
import { abortable } from "./abortable";
import type { SyncRequest, SyncResponse } from "../../server/protocol";

const LEGACY_KEY_STORAGE = "pi-remote-key";
let unlockHandler: ((message: string) => Promise<string>) | null = null;
let unlocking: Promise<void> | null = null;

function keyStorage() {
  const user = window.PiRemotePerson?.get() || "";
  return user ? `pi-remote-key:${user}` : LEGACY_KEY_STORAGE;
}

function storedKey() {
  try {
    const key = localStorage.getItem(keyStorage());
    if (key) return key;
    const legacy = localStorage.getItem(LEGACY_KEY_STORAGE) ?? "";
    if (legacy && keyStorage() !== LEGACY_KEY_STORAGE) {
      localStorage.setItem(keyStorage(), legacy);
      localStorage.removeItem(LEGACY_KEY_STORAGE);
    }
    return legacy;
  } catch {
    return "";
  }
}

function rememberKey(key: string) {
  try { localStorage.setItem(keyStorage(), key); } catch {}
}

async function responseJson(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function sendUnlock(key: string) {
  const response = await fetch(API.unlock.path(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ key }),
    cache: "no-store",
  });
  const result = await responseJson(response);
  if (response.status === 403) {
    window.PiRemotePerson?.set("");
    throw new Error(result.error || "This machine does not know you");
  }
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
}

export function registerUnlockHandler(handler: (message: string) => Promise<string>) {
  unlockHandler = handler;
}

async function ensureUnlocked() {
  if (unlocking) return unlocking;
  unlocking = (async () => {
    const saved = storedKey();
    if (saved) {
      try {
        await sendUnlock(saved);
        return;
      } catch {}
    }
    if (!unlockHandler) throw new Error("Unlock UI is unavailable");
    let message = saved ? "The saved key did not open your folder." : "";
    while (true) {
      const key = await unlockHandler(message);
      try {
        await sendUnlock(key);
        rememberKey(key);
        return;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    }
  })().finally(() => { unlocking = null; });
  return unlocking;
}

export async function piFetch(input: RequestInfo | URL, init?: RequestInit, retryOnLock = true): Promise<Response> {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const wait = <T>(operation: Promise<T>) => signal ? abortable(operation, signal) : operation;
  const response = await wait(fetch(input, init));
  if (response.status !== 423 || !retryOnLock) return response;
  await wait(ensureUnlocked());
  signal?.throwIfAborted();
  return wait(fetch(input, init));
}

export async function api(method: string, path: string, body?: unknown, timeout = 20_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeout);
  try {
    const response = await piFetch(path, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const result = await responseJson(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncRequest(body: SyncRequest, signal: AbortSignal): Promise<SyncResponse> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Synchronization timed out")), 35_000);
  try {
    const response = await piFetch(API.sync.path(), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const result = await responseJson(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result as SyncResponse;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
