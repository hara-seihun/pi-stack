import { API } from "../../server/api";
import { abortable, deadline } from "./abortable";

interface EnvironmentChoice { id: string; name: string }
interface EnvironmentState {
  id: string;
  name: string;
  baseUrl: string;
  requiresPreparation?: boolean;
  environments: EnvironmentChoice[];
}
interface RemoteBridge {
  getState(options?: object): Promise<EnvironmentState>;
  prepare(options?: object): Promise<void>;
  select(options: { id: string; user: string }): Promise<EnvironmentState>;
  haptic?(options: { kind: string }): Promise<void>;
  notifications?(options: { user: string; request: boolean }): Promise<{ enabled: boolean }>;
  notificationTarget?(): Promise<{ environment?: string; sessionId?: string; user?: string }>;
}

const capacitor = window.Capacitor;
const nativePlatform = capacitor?.isNativePlatform?.() === true;
const browserFetch = window.fetch.bind(window);
let browserEnvironments: Array<EnvironmentChoice & { baseUrl: string }> | null = null;

async function loadBrowserEnvironments() {
  if (browserEnvironments) return browserEnvironments;
  const response = await browserFetch(API.environments.path(), { cache: "no-store" });
  if (!response.ok) throw new Error(`Environment list returned HTTP ${response.status}`);
  const result = await response.json();
  browserEnvironments = result.environments;
  return browserEnvironments!;
}
async function browserSnapshot(id: string): Promise<EnvironmentState> {
  const environments = await loadBrowserEnvironments();
  const selected = environments.find((environment) => environment.id === id) ?? environments[0];
  if (!selected) throw new Error("No Pi Remote environments are configured");
  return { ...selected, requiresPreparation: false, environments: environments.map(({ id, name }) => ({ id, name })) };
}
const browserRemote: RemoteBridge = {
  getState: async () => browserSnapshot(localStorage.getItem("kenan-environment") || ""),
  prepare: async () => {},
  select: async ({ id, user }) => {
    const selected = await browserSnapshot(id);
    if (selected.id !== id) throw new Error(`Unknown Pi Remote environment: ${id}`);
    const headers = user ? { "x-pi-remote-user": user } : undefined;
    const response = await browserFetch(`${selected.baseUrl}${API.health.path()}`, { cache: "no-store", headers });
    if (!response.ok) throw new Error(`${selected.name} returned HTTP ${response.status}`);
    localStorage.setItem("kenan-environment", id);
    return selected;
  },
};
const remote: RemoteBridge = !nativePlatform
  ? browserRemote
  : typeof capacitor.registerPlugin === "function"
    ? capacitor.registerPlugin("KenanRemote")
    : {
        getState: (options = {}) => capacitor.nativePromise("KenanRemote", "getState", options),
        prepare: (options = {}) => capacitor.nativePromise("KenanRemote", "prepare", options),
        select: (options) => capacitor.nativePromise("KenanRemote", "select", options),
        haptic: (options) => capacitor.nativePromise("KenanRemote", "haptic", options),
        notifications: (options) => capacitor.nativePromise("KenanRemote", "notifications", options),
        notificationTarget: () => capacitor.nativePromise("KenanRemote", "notificationTarget", {}),
      };
export { nativePlatform, remote, browserFetch, loadBrowserEnvironments };

let statePromise: Promise<EnvironmentState> | null = null;
let current: EnvironmentState | null = null;
let preparePromise: Promise<void> | null = null;
let preparedUntil = 0;
let reconnect = false;

async function getState() {
  if (current) return current;
  statePromise ??= deadline(remote.getState(), 10_000, "Environment discovery").finally(() => { statePromise = null; });
  current = await statePromise;
  return current;
}
async function prepare() {
  const environment = await getState();
  if (!environment.requiresPreparation || Date.now() < preparedUntil) return;
  if (!preparePromise) {
    const reset = reconnect;
    reconnect = false;
    preparePromise = deadline(remote.prepare({ reconnect: reset }), 12_000, "Connection setup")
      .then(() => { preparedUntil = Date.now() + 10_000; })
      .catch((error) => { reconnect = true; throw error; })
      .finally(() => { preparePromise = null; });
  }
  return preparePromise;
}
function apiPath(input: RequestInfo | URL) {
  const value = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const parsed = new URL(value, location.href);
  return parsed.origin === location.origin && parsed.pathname.startsWith("/v1/") ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
}
async function remoteUrl(path: string) {
  const environment = await getState();
  await prepare();
  return `${environment.baseUrl}${path}`;
}
window.fetch = async (input, init) => {
  const path = apiPath(input);
  if (!path) return browserFetch(input, init);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  try {
    signal?.throwIfAborted();
    const target = await (signal ? abortable(remoteUrl(path), signal) : remoteUrl(path));
    signal?.throwIfAborted();
    return typeof input === "string" || input instanceof URL
      ? await browserFetch(target, init)
      : await browserFetch(new Request(target, input), init);
  } catch (error) {
    if (!signal?.aborted || signal.reason?.name !== "AbortError") {
      preparedUntil = 0;
      reconnect = true;
    }
    throw error;
  }
};
window.KenanRemote = {
  enabled: true,
  getState,
  select: async (options: { id: string; user: string }) => {
    current = await remote.select(options);
    statePromise = Promise.resolve(current);
    preparedUntil = 0;
    await prepare();
    return current;
  },
  resolveApiUrl(path: string) { return current ? `${current.baseUrl}${path}` : path; },
};

window.addEventListener("online", () => { preparedUntil = 0; });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") preparedUntil = 0; });

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
  window.open(await remoteUrl(path), "_blank", "noopener,noreferrer");
}, true);
