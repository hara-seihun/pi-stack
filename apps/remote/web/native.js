"use strict";

// The browser and Android builds use this same client. Capacitor injects its
// bridge only in the Android shell, so ordinary web sessions leave fetch and
// the interface untouched.
(() => {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return;

  // A source-bundled Capacitor client exposes registerPlugin; the Android
  // bridge injected ahead of an unbundled page exposes nativePromise instead.
  // Pi Remote deliberately ships plain browser assets, so support both forms.
  const remote = typeof capacitor.registerPlugin === "function"
    ? capacitor.registerPlugin("KenanRemote")
    : {
        getState: (options = {}) => capacitor.nativePromise("KenanRemote", "getState", options),
        prepare: (options = {}) => capacitor.nativePromise("KenanRemote", "prepare", options),
        select: (options = {}) => capacitor.nativePromise("KenanRemote", "select", options),
      };
  const browserFetch = window.fetch.bind(window);
  let statePromise = remote.getState();
  let current = null;
  let preparePromise = null;
  let preparedUntil = 0;

  async function getState() {
    current = current ?? await statePromise;
    return current;
  }

  async function prepare() {
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

  window.KenanDev = {
    enabled: true,
    getState,
    resolveApiUrl(path) {
      return current ? `${current.baseUrl}${path}` : path;
    },
  };

  async function mountEnvironmentControl() {
    const row = document.getElementById("native-environment");
    const select = document.getElementById("native-environment-select");
    if (!row || !select) return;
    try {
      const environment = await getState();
      document.title = "kenan-dev";
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
          current = await remote.select({ id: select.value });
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
