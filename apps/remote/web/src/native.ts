import { API } from "../../server/api";
import { appBase, appStorageKey } from "./app-path";
import { abortable, deadline } from "./abortable";
import { ensureUnlocked, registerAuthenticationBootstrap } from "./client";
import { beginRequest, reportingBridge, setRequestTimingReporter } from "./in-flight";
import type { RequestTimingReport } from "../../server/request-timings";
import { auth } from "./person";
import { resolveEndpoints, routerApiPath, sessionUrl, type Endpoint } from "./router-auth";

/** A newer client: a web bundle the shell applies in place, or an APK for Android's installer. */
export interface AppUpdate { kind: "web" | "apk"; revision: string; versionCode: number; ready: boolean }
export interface InstalledApp { revision: string; versionCode: number; applicationId: string; shellId: string; web: { revision: string; versionCode: number; builtIn: boolean } }
export interface AppUpdateCheck { update: AppUpdate | null; installed: InstalledApp }
export interface AppUpdateInstall { status: "installer-opened" | "reloading"; revision?: string }
export interface EnvironmentState extends Endpoint { environments: Endpoint[] }
interface RemoteBridge {
  getState(options?: object): Promise<{ routerUrl: string }>;
  syncSession?(options: { user: string; session: string }): Promise<void>;
  haptic?(options: { kind: string }): Promise<void>;
  keepAwake?(options: { enabled: boolean }): Promise<void>;
  notifications?(options: { request: boolean }): Promise<{ enabled: boolean }>;
  notificationTarget?(): Promise<{ environment?: string; sessionId?: string; user?: string }>;
  notificationThread?(options: { user: string; environment: string; sessionId: string }): Promise<void>;
  checkAppUpdate?(): Promise<AppUpdateCheck>;
  installAppUpdate?(): Promise<AppUpdateInstall>;
  webReady?(): Promise<void>;
}

const capacitor = window.Capacitor;
export const nativePlatform = capacitor?.isNativePlatform?.() === true;
export const browserFetch = window.fetch.bind(window);
const timingClientId = (() => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
})();
setRequestTimingReporter(timing => {
  const report: RequestTimingReport = {
    clientId: timingClientId, platform: nativePlatform ? "android" : "browser", requests: [timing],
  };
  void window.fetch(API.requestTimings.path(), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report),
  }).catch(() => undefined);
});
export const remote: RemoteBridge = !nativePlatform
  ? { getState: async () => ({ routerUrl: appBase() }) }
  : reportingBridge<RemoteBridge>(typeof capacitor.registerPlugin === "function"
    ? capacitor.registerPlugin("KenanRemote")
    : {
        getState: (options = {}) => capacitor.nativePromise("KenanRemote", "getState", options),
        syncSession: (options) => capacitor.nativePromise("KenanRemote", "syncSession", options),
        haptic: (options) => capacitor.nativePromise("KenanRemote", "haptic", options),
        keepAwake: (options) => capacitor.nativePromise("KenanRemote", "keepAwake", options),
        notifications: (options) => capacitor.nativePromise("KenanRemote", "notifications", options),
        notificationTarget: () => capacitor.nativePromise("KenanRemote", "notificationTarget", {}),
        notificationThread: (options) => capacitor.nativePromise("KenanRemote", "notificationThread", options),
        checkAppUpdate: () => capacitor.nativePromise("KenanRemote", "checkAppUpdate", {}),
        installAppUpdate: () => capacitor.nativePromise("KenanRemote", "installAppUpdate", {}),
        webReady: () => capacitor.nativePromise("KenanRemote", "webReady", {}),
      });

/** Tells the shell this web client booted, so a downloaded bundle is trusted instead of rolled back. */
export function reportWebReady() {
  if (nativePlatform && remote.webReady) void remote.webReady().catch(() => undefined);
}

let nativeSync = Promise.resolve();
export const nativeSessionReady = () => nativeSync;
function syncNativeSession() {
  if (!nativePlatform) return;
  const identity = auth.session ? { user: auth.user, session: auth.session } : { user: "", session: "" };
  const sync = () => remote.syncSession!(identity);
  nativeSync = nativeSync.then(sync, sync);
  void nativeSync.catch(error => window.dispatchEvent(new CustomEvent("pi-native-auth-error", { detail: String(error) })));
}
window.addEventListener("pi-auth", syncNativeSession);
window.addEventListener("pi-person", syncNativeSession);
syncNativeSession();

let bootstrap = "";
let bootstrapPromise: Promise<string> | null = null;
let environments: Endpoint[] | null = null;
let discovery: Promise<Endpoint[]> | null = null;
let current: EnvironmentState | null = null;
let generation = 0;
let personRequests = new AbortController();

function resetEndpoints() {
  generation++;
  environments = null;
  discovery = null;
  current = null;
}
window.addEventListener("pi-auth", resetEndpoints);
window.addEventListener("pi-person", () => {
  personRequests.abort(new DOMException("Person changed", "AbortError"));
  personRequests = new AbortController();
  resetEndpoints();
});

export async function bootstrapUrl() {
  bootstrapPromise ??= deadline(remote.getState(), 10_000, "Bootstrap connection").then(state => {
    if (typeof state.routerUrl !== "string") throw new Error("Native bridge did not supply a bootstrap URL");
    bootstrap = state.routerUrl.replace(/\/$/, "");
    return bootstrap;
  }).catch(error => { bootstrapPromise = null; throw error; });
  return bootstrapPromise;
}

export async function fetchPersonChooser(): Promise<Response> {
  const response = await browserFetch(`${await bootstrapUrl()}${API.environment.path()}`, {
    cache: "no-store", redirect: "error", credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) {
    const result = await response.clone().json();
    const authentication = result.environment?.authentication;
    if (authentication) {
      if (authentication.type !== "oidc" || authentication.loginPath !== "/v1/auth/login" || typeof authentication.label !== "string" || !authentication.label.trim()) {
        throw new Error("Router returned invalid sign-in settings");
      }
      const changed = !auth.authentication;
      auth.authentication = authentication;
      if (changed) window.dispatchEvent(new Event("pi-host-auth"));
    }
  }
  return response;
}

let authenticationReady: Promise<void> | null = null;
export async function prepareAuthentication() {
  if (!authenticationReady) {
    authenticationReady = (async () => {
      const response = await fetchPersonChooser();
      if (!response.ok) throw new Error(`Sign-in settings returned HTTP ${response.status}`);
      if (!nativePlatform || auth.authentication) await restoreBrowserSession();
    })().catch(error => { authenticationReady = null; throw error; });
    return authenticationReady;
  }
  await authenticationReady;
  if (auth.authentication && !auth.session) await restoreBrowserSession();
}

registerAuthenticationBootstrap({ prepare: prepareAuthentication, accountSignIn: () => Boolean(auth.authentication) });

async function restoreBrowserSession() {
  const response = await browserFetch(`${await bootstrapUrl()}/v1/auth/session`, {
    cache: "no-store", redirect: "error", credentials: "same-origin", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 && !auth.authentication) return;
  if (response.status === 423) {
    if (auth.authentication) auth.clear();
    return;
  }
  if (!response.ok) throw new Error(`Sign-in session returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.ok !== true || typeof result.user !== "string" || !result.user || typeof result.session !== "string" || !result.session) {
    throw new Error("Router returned an invalid sign-in session");
  }
  auth.restore(result.user, result.session);
}

export async function beginSignIn() {
  if (!auth.authentication) throw new Error("This host does not offer account sign-in");
  location.assign(`${await bootstrapUrl()}${auth.authentication.loginPath}`);
}

export async function loadEnvironments(retry = true): Promise<Endpoint[]> {
  await ensureUnlocked();
  if (environments) return environments;
  if (discovery) return discovery;
  const revision = generation;
  const token = auth.session;
  const operation = (async () => {
    const root = await bootstrapUrl();
    const response = await browserFetch(`${root}${API.environments.path()}`, { cache: "no-store", redirect: "error", headers: auth.headers(), signal: personRequests.signal });
    if (revision !== generation) throw new DOMException("Identity changed during discovery", "AbortError");
    if (response.status === 423) {
      auth.clear(token);
      if (!retry) throw new Error("Router rejected the renewed session");
      await ensureUnlocked();
      return loadEnvironments(false);
    }
    if (!response.ok) throw new Error(`Environment list returned HTTP ${response.status}`);
    const result = await response.json();
    if (revision !== generation) throw new DOMException("Identity changed during discovery", "AbortError");
    environments = resolveEndpoints(result.environments, root, location.href);
    if (!environments.length) throw new Error("No Pi Remote environments are allowed for this person");
    return environments;
  })();
  discovery = operation;
  try { return await operation; } finally { if (discovery === operation) discovery = null; }
}

async function verifiedState(selected: Endpoint, endpoints: Endpoint[]): Promise<EnvironmentState> {
  const revision = generation;
  const token = auth.session;
  const response = await browserFetch(`${selected.baseUrl}${API.health.path()}`, { cache: "no-store", redirect: "error", headers: auth.headers(), signal: personRequests.signal });
  if (revision !== generation) throw new DOMException("Identity changed during endpoint selection", "AbortError");
  if (response.status === 423) auth.clear(token);
  if (!response.ok) throw new Error(`${selected.name} health returned HTTP ${response.status}`);
  const health = await response.json();
  if (revision !== generation) throw new DOMException("Identity changed during endpoint selection", "AbortError");
  if (health.environmentId !== selected.id) throw new Error(`${selected.name} environment identity mismatch`);
  return { ...selected, environments: endpoints };
}

async function getState(): Promise<EnvironmentState> {
  const endpoints = await loadEnvironments();
  if (current) return current;
  const selectedId = sessionStorage.getItem(appStorageKey(`pi-remote-environment:${auth.user}`));
  const selected = endpoints.find(endpoint => endpoint.id === selectedId) ?? endpoints[0]!;
  current = await verifiedState(selected, endpoints);
  return current;
}

function apiPath(input: RequestInfo | URL) {
  const value = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const prefix = new URL(bootstrap || "/", location.href).pathname.replace(/\/$/, "");
  return routerApiPath(value, location.href, ["", appBase()])
    ?? (bootstrap ? routerApiPath(value, new URL(bootstrap, location.href).href, [prefix]) : null);
}

function rootPath(path: string, root: string) {
  const prefix = new URL(root || "/", location.href).pathname.replace(/\/$/, "");
  return prefix && path.startsWith(`${prefix}/v1/`) ? path.slice(prefix.length) : path;
}

function explicitTarget(path: string, root: string): string | null {
  const explicit = environments?.some(endpoint => {
    const prefix = new URL(endpoint.baseUrl || "/", location.href).pathname.replace(/\/$/, "");
    return prefix && path.startsWith(`${prefix}/v1/`);
  });
  if (!explicit) return null;
  return /^https?:/.test(root) ? new URL(path, root).href : path;
}

window.fetch = async (input, init) => {
  const path = apiPath(input);
  if (!path) return browserFetch(input, init);
  const request = input instanceof Request ? input : null;
  const signal = init?.signal ?? request?.signal;
  const combined = signal ? AbortSignal.any([signal, personRequests.signal]) : personRequests.signal;
  const run = async () => {
    const root = await bootstrapUrl();
    const operation = rootPath(path, root);
    const pathname = new URL(operation, location.href).pathname;
    const publicRoute = (pathname === API.environment.path() && !auth.session) || pathname === API.unlock.path();
    const rootRoute = publicRoute || pathname === API.environments.path() || pathname === "/v1/lock" || pathname === "/v1/lock-status";
    const selected = rootRoute || !auth.session ? null : await getState();
    const target = rootRoute ? `${root}${operation}` : explicitTarget(path, root) ?? `${selected?.baseUrl ?? root}${operation}`;
    combined.throwIfAborted();
    const headers = auth.headers(init?.headers ?? request?.headers, !publicRoute);
    const token = headers.get("x-pi-remote-session") || "";
    const url = new URL(target, location.href);
    if (url.searchParams.getAll("user").some(user => user !== auth.user)) throw new Error("Request person does not match the authenticated person");
    url.searchParams.delete("user");
    url.searchParams.delete("session");
    // Classify at the shared transport: user actions are visible, while
    // nested item/media requests and stream maintenance remain background.
    const settle = beginRequest(init?.method ?? request?.method ?? "GET", pathname);
    try {
      const response = await browserFetch(request ? new Request(url, request) : url, { ...init, headers, signal: combined, redirect: "error" });
      combined.throwIfAborted();
      if (response.status === 423 && !publicRoute) auth.clear(token);
      return response;
    } finally { settle(); }
  };
  return abortable(run(), combined);
};

function resolveApiUrl(path: string) {
  const route = apiPath(path);
  if (!route) return path;
  const target = explicitTarget(route, bootstrap) ?? `${current?.baseUrl ?? bootstrap}${rootPath(route, bootstrap)}`;
  const root = new URL(bootstrap || "/", location.href);
  const prefixes = [root.pathname.replace(/\/$/, ""), ...(environments || []).map(endpoint => new URL(endpoint.baseUrl || "/", location.href).pathname.replace(/\/$/, ""))];
  return sessionUrl(target, root.href, auth.session, prefixes);
}

window.KenanRemote = {
  enabled: true,
  getState,
  select: async ({ id, user }) => {
    if (user !== auth.user) throw new Error("Choose and unlock this person before selecting an environment");
    const endpoints = await loadEnvironments();
    const selected = endpoints.find(endpoint => endpoint.id === id);
    if (!selected) throw new Error(`Environment is not allowed: ${id}`);
    const verified = await verifiedState(selected, endpoints);
    sessionStorage.setItem(appStorageKey(`pi-remote-environment:${user}`), id);
    current = verified;
    return current;
  },
  resolveApiUrl,
};

if (nativePlatform && remote.haptic) {
  const tactileSelector = "button:not(:disabled), select:not(:disabled), input:not(:disabled), [role=button]";
  const target = (event: Event) => (event.target as Element | null)?.closest?.(tactileSelector);
  const kind = (element: Element | null) => element?.id === "action" ? element.classList.contains("abort") ? "reject" : "confirm" : element?.id === "voice" ? "confirm" : "select";
  const haptic = (value: string) => { void remote.haptic?.({ kind: value }); };
  document.addEventListener("pointerdown", (event) => { const element = target(event); if (element) haptic(kind(element) === "select" ? "press" : kind(element)); }, { capture: true, passive: true });
  document.addEventListener("pointerup", (event) => { if (target(event)) haptic("release"); }, { capture: true, passive: true });
  document.addEventListener("change", (event) => { if (target(event)) haptic("select"); }, true);
  document.addEventListener("click", (event) => { const element = target(event); if (element && event.detail === 0) haptic(kind(element)); }, true);
}

document.addEventListener("click", async (event) => {
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const path = apiPath(anchor.href);
  if (!path) return;
  event.preventDefault();
  await getState();
  window.open(resolveApiUrl(path), "_blank", "noopener,noreferrer");
}, true);
