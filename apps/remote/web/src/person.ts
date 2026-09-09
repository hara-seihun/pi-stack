// Which person this device speaks as. The front door on a machine with more
// than one person needs a name on every API request; the folder key is what
// actually opens anything, so the name is just an address. Loaded before any
// other script so every fetch in the app, the voice page, and the native shell
// carries the header without knowing about it. A navigation cannot carry a
// header, so a link to the API (a download opened in a tab, or saved from its
// context menu) names the person in its query instead; the front door reads
// either.
(() => {
  "use strict";
  const PERSON_STORAGE = "pi-remote-person";
  const read = () => { try { return localStorage.getItem(PERSON_STORAGE) || ""; } catch { return ""; } };
  const write = (user: string) => {
    try { user ? localStorage.setItem(PERSON_STORAGE, user) : localStorage.removeItem(PERSON_STORAGE); } catch {}
    window.dispatchEvent(new Event("pi-person"));
  };

  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const user = read();
    if (!user) return original(input, init);
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    let pathname = "";
    try { pathname = new URL(url, window.location.href).pathname; } catch { return original(input, init); }
    if (!/(^|\/)v1\//.test(pathname)) return original(input, init);
    if (typeof input === "string" || input instanceof URL) {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has("x-pi-remote-user")) headers.set("x-pi-remote-user", user);
      return original(input, { ...init, headers });
    }
    const request = new Request(input, init);
    if (!request.headers.has("x-pi-remote-user")) request.headers.set("x-pi-remote-user", user);
    return original(request);
  };

  const href = (path: string) => {
    const user = read();
    if (!user) return path;
    const url = new URL(path, window.location.href);
    if (!url.searchParams.has("user")) url.searchParams.set("user", user);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
  };

  window.PiRemotePerson = Object.freeze({ get: read, set: write, header: "x-pi-remote-user", href });
})();
