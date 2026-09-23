import { RouterAuth, sessionUrl } from "./router-auth";
import { appStorage, appStorageKey } from "./app-path";

export const auth = new RouterAuth(appStorage(localStorage), appStorage(sessionStorage), (kind) => {
  window.dispatchEvent(new Event(`pi-${kind}`));
});

window.PiRemotePerson = Object.freeze({
  get: () => auth.user,
  set: (user: string) => auth.setPerson(user),
  header: "x-pi-remote-user",
  session: () => auth.session,
  acceptSession: (user: string, session: string) => auth.accept(user, session),
  clearSession: (session?: string) => auth.clear(session),
  headers: (initial?: HeadersInit, includeSession = true) => auth.headers(initial, includeSession),
  href: (path: string) => window.KenanRemote?.resolveApiUrl(path) ?? sessionUrl(path, location.href, auth.session),
});

window.addEventListener("storage", (event) => {
  if (!auth.authentication && event.key === appStorageKey("pi-remote-person")) auth.setPerson(event.newValue || "");
});
