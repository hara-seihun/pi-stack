import { RouterAuth, sessionUrl } from "./router-auth";

localStorage.removeItem("pi-remote-key");
localStorage.removeItem("kenan-environment");

export const auth = new RouterAuth(localStorage, sessionStorage, (kind) => {
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
  href: (path: string) => sessionUrl(path, location.href, auth.session),
});

window.addEventListener("storage", (event) => {
  if (event.key === "pi-remote-person") auth.setPerson(event.newValue || "");
});
