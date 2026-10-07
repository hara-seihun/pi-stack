// Hash routes. HTML pages live directly under the mount, so the address bar
// carries the view in the fragment: the ingress and the router never see it.
// Every user-visible navigation pushes a history entry so back always returns
// to the previous screen, on the phone and in the browser.
import { useEffect, useState } from "react";
import type { ChatId } from "../chats";
import { assertNever, requireState } from "../../../shared/explicit-state";

export type Tab = "chats" | "agents" | "notifications" | "files" | "calendar" | "machine";
export type Panel = "inspector" | "queue" | "settings";

export type Route =
  | { tab: "chats"; chat: ChatId | null; panel: Panel | null }
  | { tab: "agents" }
  | { tab: "files"; path: string | null }
  | { tab: "calendar" }
  | { tab: "notifications" }
  | { tab: "machine" };

export const TABS: Tab[] = ["chats", "agents", "notifications", "calendar", "files", "machine"];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(part => decodeURIComponent(part));
  const [name, ...rest] = parts;
  if (name === "" && rest.length === 0) return { tab: "chats", chat: null, panel: null };
  const panel = (value: string | undefined): Panel | null => value === undefined ? null : requireState(value, { inspector: true, queue: true, settings: true } satisfies Record<Panel, true>, "Route panel");
  if (name === "workers") return rest[0] ? { tab: "chats", chat: `ai:${rest[0]}`, panel: panel(rest[1]) } : { tab: "agents" };
  const tab = requireState(name, { chats: true, agents: true, notifications: true, files: true, calendar: true, machine: true } satisfies Record<Tab, true>, "Route tab");
  switch (tab) {
    case "files": return { tab, path: rest.length ? `/${rest.filter(Boolean).join("/")}` : null };
    case "agents": case "calendar": case "machine": case "notifications": return { tab };
    case "chats": {
      const kind = rest[0];
      const id = rest[1];
      if (kind !== undefined) requireState(kind, { ai: true, human: true, room: true }, "Chat route kind");
      if (kind !== undefined && !id) throw new Error("Chat route requires an id");
      const chat = kind && id ? `${kind}:${id}` as ChatId : null;
      return { tab: "chats", chat, panel: chat ? panel(rest[2]) : null };
    }
  }
  return assertNever(tab, "Route parser");
}

export function formatRoute(route: Route): string {
  const segment = (value: string) => encodeURIComponent(value);
  switch (route.tab) {
    case "chats": {
      if (!route.chat) return "#/chats";
      const [kind, ...id] = route.chat.split(":");
      return `#/chats/${kind}/${segment(id.join(":"))}${route.panel ? `/${route.panel}` : ""}`;
    }
    case "agents": return "#/agents";
    case "files": return route.path ? `#/files/${route.path.split("/").filter(Boolean).map(segment).join("/")}` : "#/files";
    case "notifications": return "#/notifications";
    case "calendar": return "#/calendar";
    case "machine": return "#/machine";
  }
  return assertNever(route, "Route formatting");
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
    case "agents": return { tab: "agents" };
    case "files": return { tab: "files", path: null };
    case "notifications": return { tab: "notifications" };
    case "calendar": return { tab: "calendar" };
    case "machine": return { tab: "machine" };
  }
  return assertNever(route, "Route home");
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
  switch (route.tab) {
    case "chats": return route.chat?.startsWith("ai:") ? route.chat.slice(3) : null;
    case "agents": case "files": case "calendar": case "machine": case "notifications": return null;
  }
  return assertNever(route, "Route thread");
}

export function routeChatId(route: Route): ChatId | null {
  switch (route.tab) {
    case "chats": return route.chat;
    case "agents": case "files": case "calendar": case "machine": case "notifications": return null;
  }
  return assertNever(route, "Route chat");
}
