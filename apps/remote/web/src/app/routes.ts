// Hash routes. HTML pages live directly under the mount, so the address bar
// carries the view in the fragment: the ingress and the router never see it.
// Every user-visible navigation pushes a history entry so back always returns
// to the previous screen, on the phone and in the browser.
import { useEffect, useState } from "react";
import type { ChatId } from "../chats";

export type Tab = "chats" | "workers" | "files" | "machine";
export type Panel = "inspector" | "queue" | "settings";

export type Route =
  | { tab: "chats"; chat: ChatId | null; panel: Panel | null }
  | { tab: "workers"; thread: string | null; panel: Panel | null }
  | { tab: "files"; path: string | null }
  | { tab: "machine" };

export const TABS: Tab[] = ["chats", "workers", "files", "machine"];
const PANELS: Panel[] = ["inspector", "queue", "settings"];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(part => { try { return decodeURIComponent(part); } catch { return part; } });
  const [tab, ...rest] = parts;
  const panel = (value: string | undefined): Panel | null => PANELS.includes(value as Panel) ? value as Panel : null;
  switch (tab) {
    case "workers": return { tab, thread: rest[0] || null, panel: rest[0] ? panel(rest[1]) : null };
    case "files": return { tab, path: rest.length ? `/${rest.filter(Boolean).join("/")}` : null };
    case "machine": return { tab };
    case "chats": {
      const kind = rest[0];
      const id = rest[1];
      const chat = (kind === "ai" || kind === "human") && id ? `${kind}:${id}` as ChatId : null;
      return { tab: "chats", chat, panel: chat ? panel(rest[2]) : null };
    }
    default: return { tab: "chats", chat: null, panel: null };
  }
}

export function formatRoute(route: Route): string {
  const segment = (value: string) => encodeURIComponent(value);
  switch (route.tab) {
    case "chats": {
      if (!route.chat) return "#/chats";
      const [kind, ...id] = route.chat.split(":");
      return `#/chats/${kind}/${segment(id.join(":"))}${route.panel ? `/${route.panel}` : ""}`;
    }
    case "workers": return route.thread ? `#/workers/${segment(route.thread)}${route.panel ? `/${route.panel}` : ""}` : "#/workers";
    case "files": return route.path ? `#/files/${route.path.split("/").filter(Boolean).map(segment).join("/")}` : "#/files";
    case "machine": return "#/machine";
  }
}

export function currentRoute(): Route { return parseRoute(location.hash); }

export function navigate(route: Route, options: { replace?: boolean } = {}) {
  const hash = formatRoute(route);
  if (hash === location.hash) return;
  if (options.replace) history.replaceState(history.state, "", hash);
  else history.pushState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: location.href, newURL: location.href }));
}

export function back() { history.back(); }

/** The route's tab-level home, used when a screen wants to close itself and
 * there is no history to pop (a deep link opened straight into it). */
export function routeHome(route: Route): Route {
  switch (route.tab) {
    case "chats": return { tab: "chats", chat: null, panel: null };
    case "workers": return { tab: "workers", thread: null, panel: null };
    case "files": return { tab: "files", path: null };
    case "machine": return { tab: "machine" };
  }
}

export function withoutPanel(route: Route): Route {
  return "panel" in route ? { ...route, panel: null } : route;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    if (!location.hash) history.replaceState(null, "", formatRoute(route));
    const update = () => setRoute(currentRoute());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => { window.removeEventListener("hashchange", update); window.removeEventListener("popstate", update); };
  }, []);
  return route;
}

/** The selected AI thread id for any route that can show a conversation. */
export function routeThreadId(route: Route): string | null {
  if (route.tab === "chats") return route.chat?.startsWith("ai:") ? route.chat.slice(3) : null;
  if (route.tab === "workers") return route.thread;
  return null;
}

export function routeChatId(route: Route): ChatId | null {
  if (route.tab === "chats") return route.chat;
  if (route.tab === "workers" && route.thread) return `ai:${route.thread}`;
  return null;
}
