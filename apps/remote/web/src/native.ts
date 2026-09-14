import { API } from "../../server/api";
import { abortable, deadline } from "./abortable";
import { ensureUnlocked } from "./client";
import { auth } from "./person";
import { resolveEndpoints, routerApiPath, sessionUrl, type Endpoint } from "./router-auth";

export interface AppRelease { revision: string; versionCode: number }
export interface InstalledApp { revision: string; versionCode: number; applicationId: string }
export interface AppUpdateCheck { release: AppRelease | null; installed: InstalledApp }
export interface AppUpdateInstall { status: "installer-opened" }
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
}

const capacitor = window.Capacitor;
export const nativePlatform = capacitor?.isNativePlatform?.() === true;
export const browserFetch = window.fetch.bind(window);
export const remote: RemoteBridge = !nativePlatform
  ? { getState: async () => ({ routerUrl: "" }) }
  : typeof capacitor.registerPlugin === "function"
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
      };

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

async function bootstrapUrl() {
  bootstrapPromise ??= deadline(remote.getState(), 10_000, "Bootstrap connection").then(state => {
    if (typeof state.routerUrl !== "string") throw new Error("Native bridge did not supply a bootstrap URL");
    bootstrap = state.routerUrl.replace(/\/$/, "");
    return bootstrap;
  }).catch(error => { bootstrapPromise = null; throw error; });
  return bootstrapPromise;
}

export async function fetchPersonChooser(): Promise<Response> {
  return browserFetch(`${await bootstrapUrl()}${API.environment.path()}`, { cache: "no-store", redirect: "error", headers: auth.headers({ accept: "application/json" }, false) });
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
  const selectedId = sessionStorage.getItem(`pi-remote-environment:${auth.user}`);
  const selected = endpoints.find(endpoint => endpoint.id === selectedId) ?? endpoints[0]!;
  current = await verifiedState(selected, endpoints);
  return current;
}

function apiPath(input: RequestInfo | URL) {
  const value = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  return routerApiPath(value, location.href);
}

window.fetch = async (input, init) => {
  const path = apiPath(input);
  if (!path) return browserFetch(input, init);
  const request = input instanceof Request ? input : null;
  const signal = init?.signal ?? request?.signal;
  const combined = signal ? AbortSignal.any([signal, personRequests.signal]) : personRequests.signal;
  const run = async () => {
    const pathname = new URL(path, location.href).pathname;
    const publicRoute = (pathname === API.environment.path() && !auth.session) || pathname === API.unlock.path();
    const rootRoute = publicRoute || pathname === API.environments.path() || pathname === "/v1/lock" || pathname === "/v1/lock-status";
    const root = await bootstrapUrl();
    const selected = rootRoute || !auth.session ? null : await getState();
    const explicitEndpoint = environments?.find(endpoint => endpoint.baseUrl && path.startsWith(`${endpoint.baseUrl}/v1/`));
    const target = explicitEndpoint ? path : `${selected?.baseUrl ?? root}${path}`;
    combined.throwIfAborted();
    const headers = auth.headers(init?.headers ?? request?.headers, !publicRoute);
    const token = headers.get("x-pi-remote-session") || "";
    const url = new URL(target, location.href);
    if (url.searchParams.getAll("user").some(user => user !== auth.user)) throw new Error("Request person does not match the authenticated person");
    url.searchParams.delete("user");
    url.searchParams.delete("session");
    const response = await browserFetch(request ? new Request(url, request) : url, { ...init, headers, signal: combined, redirect: "error" });
    combined.throwIfAborted();
    if (response.status === 423 && !publicRoute) auth.clear(token);
    return response;
  };
  return abortable(run(), combined);
};

function resolveApiUrl(path: string) {
  if (!apiPath(path)) return path;
  const explicitEndpoint = environments?.find(endpoint => endpoint.baseUrl && path.startsWith(`${endpoint.baseUrl}/v1/`));
  const target = explicitEndpoint ? path : `${current?.baseUrl ?? bootstrap}${path}`;
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
    sessionStorage.setItem(`pi-remote-environment:${user}`, id);
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
