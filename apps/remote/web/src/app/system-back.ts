// Android's back gesture arrives here from the shell as `window.PiRemoteBack()`
// and gets the same treatment as the client's own back arrow: whatever is on
// top closes first. The answer tells the shell whether anything moved; when
// nothing did, the shell puts the app in the background instead of the client
// pretending it handled it.
import { useEffect } from "react";
import { currentRoute, navigate, type Route } from "./routes";

export type BackActions = {
  closePanel(): void;
  closeDetail(): void;
};

/** True when the route shows something a back press should leave. */
export function routeHasDetail(route: Route): boolean {
  switch (route.tab) {
    case "chats": return route.chat !== null;
    case "workers": return route.thread !== null;
    case "files": return route.path !== null;
    case "machine": return false;
  }
}

/**
 * Chooses what one back press does. Overlays that are not part of the route
 * (a long-press menu, the drawing editor, a confirmation dialog) close on
 * Escape already, so they get the Escape they expect. A dialog that refuses
 * to cancel, like unlock, leaves nothing for back to do.
 */
export function systemBack(actions: BackActions, root: Document = document): boolean {
  const route = currentRoute();
  const dialog = root.querySelector<HTMLDialogElement>("dialog[open]");
  if (dialog) {
    if (dialog.classList.contains("sheet") && "panel" in route && route.panel) { actions.closePanel(); return true; }
    if (dialog.classList.contains("unlock-dialog") || dialog.classList.contains("sign-in-dialog")) return false;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    return true;
  }
  const overlay = root.querySelector(".thread-color-palette.is-open, .chat-picker-popover, .message-menu, .drawing-slot:not([hidden]) .drawing-canvas");
  if (overlay) {
    // The menu listens on the document and the editor on the window; a bubbling keydown reaches both.
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  }
  if ("panel" in route && route.panel) { actions.closePanel(); return true; }
  if (routeHasDetail(route)) { actions.closeDetail(); return true; }
  if (route.tab !== "chats") { navigate({ tab: "chats", chat: null, panel: null }, { replace: true }); return true; }
  return false;
}

export function useSystemBack(actions: BackActions) {
  useEffect(() => {
    window.PiRemoteBack = () => systemBack(actions);
    return () => { delete window.PiRemoteBack; };
  }, [actions.closePanel, actions.closeDetail]);
}
