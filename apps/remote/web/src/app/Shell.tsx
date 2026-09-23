import type { ReactNode } from "react";
import type { Layout } from "./layout";
import { TABS, type Tab } from "./routes";
import "./shell.css";

const LABELS: Record<Tab, string> = { chats: "Chats", workers: "Workers", files: "Files", machine: "Machine" };

function TabIcon({ tab }: { tab: Tab }) {
  switch (tab) {
    case "chats": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>;
    case "workers": return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M12 7.5v4M6 15.5v-4h12v4" /></svg>;
    case "files": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v10H3v-12Z" /></svg>;
    case "machine": return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8m-4-4v4" /></svg>;
  }
}

export interface TabBadge { count: number; attention?: boolean }

export function TabNav({ layout, active, badges, onSelect }: { layout: Layout; active: Tab; badges: Partial<Record<Tab, TabBadge>>; onSelect(tab: Tab): void }) {
  return <nav className={layout === "phone" ? "tabbar" : "rail"} aria-label="Sections">
    {TABS.map(tab => {
      const badge = badges[tab];
      const showBadge = active !== tab && badge && badge.count > 0;
      return <button key={tab} type="button" className="tab" aria-current={active === tab ? "page" : undefined} aria-label={showBadge ? `${LABELS[tab]}, ${badge.count}` : LABELS[tab]} title={LABELS[tab]} onClick={() => onSelect(tab)}>
        <span className="tab-icon"><TabIcon tab={tab} />{showBadge && <span className={`tab-badge${badge.attention ? " attention" : ""}`}>{badge.count > 99 ? "99+" : badge.count}</span>}</span>
      </button>;
    })}
  </nav>;
}

/** Arranges nav, list and detail for the current layout. On the phone only
 * one of list/detail is visible: the detail when `showDetail` is true. */
export function Shell({ layout, nav, list, detail, showDetail, showTabs = !showDetail, overlays }: { layout: Layout; nav: ReactNode; list: ReactNode | null; detail: ReactNode; showDetail: boolean; /** Phone only: keep the tab bar under a top-level detail such as Machine. */ showTabs?: boolean; overlays?: ReactNode }) {
  const single = list === null;
  return <div id="app" className={`shell layout-${layout}${showDetail ? " detail" : " list"}${single ? " single" : ""}`}>
    {layout !== "phone" && nav}
    {!single && <div className="pane pane-list" hidden={layout === "phone" && showDetail}>{list}</div>}
    <div className="pane pane-detail" hidden={layout === "phone" && !showDetail}>{detail}</div>
    {layout === "phone" && showTabs && nav}
    {overlays}
  </div>;
}
