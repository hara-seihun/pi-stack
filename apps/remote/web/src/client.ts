import { API } from "../../server/api";
import { appStorageKey } from "./app-path";
import { abortable } from "./abortable";

let unlockHandler: ((message: string) => Promise<string>) | null = null;
let unlocking: Promise<void> | null = null;
let signInHandler: ((message: string) => void) | null = null;
let authentication: { prepare(): Promise<void>; accountSignIn(): boolean } | null = null;

export function registerAuthenticationBootstrap(bootstrap: NonNullable<typeof authentication>) {
  authentication = bootstrap;
}

export function registerSignInHandler(handler: (message: string) => void) {
  signInHandler = handler;
  return () => { if (signInHandler === handler) signInHandler = null; };
}

function storedKey(user: string) {
  try { return user ? localStorage.getItem(appStorageKey(`pi-remote-key:${user}`)) || "" : ""; } catch { return ""; }
}

function rememberKey(user: string, key: string) {
  try { localStorage.setItem(appStorageKey(`pi-remote-key:${user}`), key); } catch {}
}

async function responseJson(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function sendUnlock(key: string) {
  const user = window.PiRemotePerson.get();
  if (!user) throw new Error("Choose a person first");
  const response = await fetch(API.unlock.path(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-pi-remote-user": user },
    body: JSON.stringify(key ? { key } : {}),
    cache: "no-store",
  });
  const result = await responseJson(response);
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  if (result.ok !== true || result.user !== user || typeof result.session !== "string" || !result.session) throw new Error("Router returned an invalid unlock session");
  window.PiRemotePerson.acceptSession(user, result.session);
  return user;
}

export function registerUnlockHandler(handler: (message: string) => Promise<string>) {
  unlockHandler = handler;
}

export async function ensureUnlocked() {
  if (unlocking) return unlocking;
  unlocking = (async () => {
    if (!authentication) throw new Error("Router authentication is unavailable");
    try { await authentication.prepare(); }
    catch (error) {
      if (authentication.accountSignIn()) signInHandler?.(error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (window.PiRemotePerson.session()) return;
    if (authentication.accountSignIn()) {
      signInHandler?.("");
      throw new Error("Sign in to continue");
    }
    const saved = storedKey(window.PiRemotePerson.get());
    if (saved) {
      try {
        await sendUnlock(saved);
        return;
      } catch {}
    }
    if (!saved && window.PiRemotePerson.get()) {
      const response = await fetch(API.environment.path(), { cache: "no-store" });
      if (!response.ok) throw new Error(`Person chooser returned HTTP ${response.status}`);
      const result = await responseJson(response);
      const people = result.environment?.persons || result.persons || [];
      const person = people.find((candidate: { user: string }) => candidate.user === window.PiRemotePerson.get());
      if (person?.requiresUnlock === false) { await sendUnlock(""); return; }
    }
    if (!unlockHandler) throw new Error("Unlock UI is unavailable. Open Pi Remote to choose and unlock your folder.");
    let message = saved ? "The saved key did not open your folder." : "";
    while (true) {
      const key = await unlockHandler(message);
      try {
        const user = await sendUnlock(key);
        rememberKey(user, key);
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
  const send = () => fetch(input instanceof Request ? input.clone() : input, init);
  const session = window.PiRemotePerson.session();
  const response = await wait(send());
  if (response.status !== 423 || !retryOnLock) return response;
  window.PiRemotePerson.clearSession(session);
  await wait(ensureUnlocked());
  signal?.throwIfAborted();
  return wait(send());
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
