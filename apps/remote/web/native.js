import { API } from "./api.js";

"use strict";

// The browser and Android builds use this same client. Capacitor injects its
// bridge only in the Android shell, so ordinary web sessions leave fetch and
// the interface untouched.
(() => {
  const capacitor = window.Capacitor;
  const nativePlatform = capacitor?.isNativePlatform?.() === true;
  const browserPlatform = /^\/dev(?:\/|$)/.test(window.location.pathname);
  if (!nativePlatform && !browserPlatform) return;

  const browserFetch = window.fetch.bind(window);
  // The host this page came from says which environments it can reach and by
  // which path prefix; the page hardcodes none of them.
  let browserEnvironments = null;
  async function loadBrowserEnvironments() {
    if (browserEnvironments) return browserEnvironments;
    const response = await browserFetch(API.environments.path(), { cache: "no-store" });
    if (!response.ok) throw new Error(`Environment list returned HTTP ${response.status}`);
    const { environments } = await response.json();
    browserEnvironments = environments.map((environment) => ({ ...environment, requiresUnlock: false }));
    return browserEnvironments;
  }
  const browserSnapshot = async (id) => {
    const environments = await loadBrowserEnvironments();
    const selected = environments.find((environment) => environment.id === id) ?? environments[0];
    return { ...selected, requiresPreparation: false, environments: environments.map(({ id, name }) => ({ id, name })) };
  };
  const browserRemote = {
    getState: async () => browserSnapshot(localStorage.getItem("kenan-environment") || ""),
    prepare: async () => {},
    select: async ({ id }) => {
      const selected = await browserSnapshot(id);
      if (selected.id !== id) throw new Error(`Unknown Pi Remote environment: ${id}`);
      const response = await browserFetch(`${selected.baseUrl}${API.health.path()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`${selected.name} returned HTTP ${response.status}`);
      localStorage.setItem("kenan-environment", id);
      return selected;
    },
  };

  // A source-bundled Capacitor client exposes registerPlugin; the Android
  // bridge injected ahead of an unbundled page exposes nativePromise instead.
  // Pi Remote deliberately ships plain browser assets, so support both forms.
  const remote = !nativePlatform
    ? browserRemote
    : typeof capacitor.registerPlugin === "function"
      ? capacitor.registerPlugin("KenanRemote")
      : {
          getState: (options = {}) => capacitor.nativePromise("KenanRemote", "getState", options),
          prepare: (options = {}) => capacitor.nativePromise("KenanRemote", "prepare", options),
          select: (options = {}) => capacitor.nativePromise("KenanRemote", "select", options),
          haptic: (options = {}) => capacitor.nativePromise("KenanRemote", "haptic", options),
        };
  let statePromise = remote.getState();
  let current = null;
  let preparePromise = null;
  let preparedUntil = 0;

  async function getState() {
    current = current ?? await statePromise;
    return current;
  }

  async function prepare() {
    const environment = await getState();
    if (!environment.requiresPreparation) return;
    if (preparePromise) return preparePromise;
    if (Date.now() < preparedUntil) return;
    preparePromise = remote.prepare()
      .then(() => { preparedUntil = Date.now() + 10_000; })
      .finally(() => { preparePromise = null; });
    return preparePromise;
  }

  function apiPath(input) {
    const value = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    if (!value) return null;
    const parsed = new URL(value, window.location.href);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith("/v1/")) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  async function remoteUrl(path) {
    const environment = await getState();
    await prepare();
    return `${environment.baseUrl}${path}`;
  }

  window.fetch = async (input, init) => {
    const path = apiPath(input);
    if (!path) return browserFetch(input, init);
    const target = await remoteUrl(path);
    try {
      if (typeof input === "string" || input instanceof URL) return await browserFetch(target, init);
      return await browserFetch(new Request(target, input), init);
    } catch (error) {
      preparedUntil = 0;
      throw error;
    }
  };

  window.KenanRemote = {
    enabled: true,
    getState,
    resolveApiUrl(path) {
      return current ? `${current.baseUrl}${path}` : path;
    },
  };

  if (nativePlatform) {
    const tactileSelector = "button:not(:disabled), select:not(:disabled), input:not(:disabled), [role=button]";
    const tactileTarget = (event) => event.target?.closest?.(tactileSelector);
    const hapticKind = (target) => {
      if (target?.id === "action") return target.classList.contains("abort") ? "reject" : "confirm";
      if (target?.id === "voice") return "confirm";
      return "select";
    };
    const haptic = (kind) => { remote.haptic({ kind }).catch(() => {}); };

    document.addEventListener("pointerdown", (event) => {
      const target = tactileTarget(event);
      if (target) haptic(hapticKind(target) === "select" ? "press" : hapticKind(target));
    }, { capture: true, passive: true });
    document.addEventListener("pointerup", (event) => {
      if (tactileTarget(event)) haptic("release");
    }, { capture: true, passive: true });
    document.addEventListener("change", (event) => {
      if (tactileTarget(event)) haptic("select");
    }, true);
    document.addEventListener("click", (event) => {
      const target = tactileTarget(event);
      if (target && event.detail === 0) haptic(hapticKind(target));
    }, true);
  }

  async function mountEnvironmentControl() {
    const row = document.getElementById("native-environment");
    const select = document.getElementById("native-environment-select");
    if (!row || !select) return;
    try {
      const environment = await getState();
      document.title = "Kenan";
      select.replaceChildren(...environment.environments.map((candidate) => {
        const option = document.createElement("option");
        option.value = candidate.id;
        option.textContent = candidate.name;
        return option;
      }));
      select.value = environment.id;
      select.addEventListener("change", async () => {
        select.disabled = true;
        try {
          current = await remote.select({ id: select.value, user: window.PiRemotePerson?.get() || "" });
          statePromise = Promise.resolve(current);
          preparedUntil = 0;
          await prepare();
          window.location.reload();
        } catch (error) {
          select.value = current?.id ?? environment.id;
          select.disabled = false;
          row.title = error?.message || "Could not switch environment";
        }
      });
      row.hidden = false;
    } catch (error) {
      row.hidden = false;
      row.classList.add("failed");
      row.title = error?.message || "Could not load environments";
    }
  }

  // File links are emitted by the Markdown renderer. Resolve them against the
  // selected machine rather than Capacitor's bundled-asset origin.
  document.addEventListener("click", async (event) => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor) return;
    const path = apiPath(anchor.getAttribute("href"));
    if (!path) return;
    event.preventDefault();
    const target = await remoteUrl(path);
    window.open(target, "_blank", "noopener,noreferrer");
  }, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountEnvironmentControl, { once: true });
  else mountEnvironmentControl();
})();
