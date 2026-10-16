import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Layout } from "./layout";
import { TABS, type Tab } from "./routes";
import "./shell.css";
import { useLongPress } from "./long-press";
import { assertNever } from "../../../shared/explicit-state";

const LABELS: Record<Tab, string> = { chats: "Chats", attention: "Attention", agents: "Agents", files: "Files", machine: "Machine", settings: "Settings" };

function TabIcon({ tab }: { tab: Tab }) {
  switch (tab) {
    case "chats": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>;
    case "agents": return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M12 7.5v4M6 15.5v-4h12v4" /></svg>;
    case "attention": return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v7m0 4v1" /></svg>;
    case "files": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v10H3v-12Z" /></svg>;
    case "machine": return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8m-4-4v4" /></svg>;
    case "settings": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></svg>;
  }
  return assertNever(tab, "Tab icon");
}

export interface TabBadge { count: number; attention?: boolean }

export interface UpdateTab { visible: boolean; busy: boolean; status: string; onClick(): void }

function ChatsTab({ onMono, onPointerDown, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { onMono?(): void }) {
  const monoPress = useLongPress(onMono);
  return <button {...props} {...monoPress} onPointerDown={event => { onPointerDown?.(event); monoPress.onPointerDown(event); }} />;
}

export function TabNav({ layout, active, badges, onSelect, onPrepare, onMono, update }: { layout: Layout; active: Tab; badges: Partial<Record<Tab, TabBadge>>; onSelect(tab: Tab): void; onPrepare?(tab: Tab): void; onMono?(): void; update?: UpdateTab }) {
  return <nav className={layout === "phone" ? "tabbar" : "rail"} aria-label="Sections">
    {TABS.map(tab => {
      const badge = badges[tab];
      const offeredUpdate = tab === "settings" && update?.visible;
      const showBadge = active !== tab && badge && badge.count > 0;
      const label = LABELS[tab];
      const Button = tab === "chats" ? ChatsTab : "button";
      return <Button {...(tab === "chats" ? { onMono } : {})} key={tab} type="button" className={`tab${offeredUpdate ? " tab-update" : ""}`} aria-current={active === tab ? "page" : undefined} aria-label={showBadge ? `${label}, ${badge.count}` : label} title={tab === "chats" && onMono ? "Chats · Long-press for mono view" : offeredUpdate ? `${label}: ${update.status}` : label} onPointerDown={() => onPrepare?.(tab)} onFocus={() => onPrepare?.(tab)} onClick={() => onSelect(tab)}>
        <span className="tab-icon"><TabIcon tab={tab} />{showBadge && <span className={`tab-badge${badge.attention ? " attention" : ""}`}>{badge.count > 99 ? "99+" : badge.count}</span>}</span>
        <span className={offeredUpdate ? "tab-update-label" : "tab-label"}>{offeredUpdate ? "Update" : label}</span>
      </Button>;
    })}
  </nav>;
}

/** Arranges nav, list and detail for the current layout. On the phone only
 * one of list/detail is visible: the detail when `showDetail` is true. */
export function Shell({ layout, nav, list, detail, showDetail, showTabs = !showDetail, mono = false, overlays }: { layout: Layout; nav: ReactNode; list: ReactNode | null; detail: ReactNode; showDetail: boolean; mono?: boolean; /** Phone only: keep the tab bar under a top-level detail such as Machine. */ showTabs?: boolean; overlays?: ReactNode }) {
  const single = mono || list === null;
  return <div id="app" className={`shell layout-${layout}${showDetail ? " detail" : " list"}${single ? " single" : ""}${mono ? " mono" : ""}`}>
    {!mono && layout !== "phone" && nav}
    {!mono && !single && <div className="pane pane-list" hidden={layout === "phone" && showDetail}>{list}</div>}
    <div className="pane pane-detail" hidden={!mono && layout === "phone" && !showDetail}>{detail}</div>
    {!mono && layout === "phone" && showTabs && nav}
    {overlays}
  </div>;
}
