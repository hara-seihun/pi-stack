import type { ReactNode } from "react";
import type { Layout } from "./layout";
import { TABS, type Tab } from "./routes";
import "./shell.css";
import { assertNever } from "../../../shared/explicit-state";

const LABELS: Record<Tab, string> = { chats: "Chats", attention: "Attention", agents: "Agents", files: "Files", machine: "Machine" };

function TabIcon({ tab }: { tab: Tab }) {
  switch (tab) {
    case "chats": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>;
    case "agents": return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M12 7.5v4M6 15.5v-4h12v4" /></svg>;
    case "attention": return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v7m0 4v1" /></svg>;
    case "files": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v10H3v-12Z" /></svg>;
    case "machine": return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8m-4-4v4" /></svg>;
  }
  return assertNever(tab, "Tab icon");
}

export interface TabBadge { count: number; attention?: boolean }

export interface UpdateTab { visible: boolean; busy: boolean; status: string; onClick(): void }

export function TabNav({ layout, active, badges, onSelect, update }: { layout: Layout; active: Tab; badges: Partial<Record<Tab, TabBadge>>; onSelect(tab: Tab): void; update?: UpdateTab }) {
  return <nav className={layout === "phone" ? "tabbar" : "rail"} aria-label="Sections">
    {TABS.map(tab => {
      const badge = badges[tab];
      const updating = tab === "machine" && update?.visible;
      const showBadge = !updating && active !== tab && badge && badge.count > 0;
      const label = updating ? "Update" : LABELS[tab];
      return <button key={tab} type="button" className={`tab${updating ? " tab-update" : ""}`} aria-current={!updating && active === tab ? "page" : undefined} aria-label={showBadge ? `${label}, ${badge.count}` : label} aria-busy={updating ? update.busy : undefined} disabled={updating && update.busy} title={updating ? update.status : label} onClick={() => updating ? update.onClick() : onSelect(tab)}>
        <span className="tab-icon">{updating ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></svg> : <TabIcon tab={tab} />}{showBadge && <span className={`tab-badge${badge.attention ? " attention" : ""}`}>{badge.count > 99 ? "99+" : badge.count}</span>}</span>
        {updating && <span className="tab-update-label">Update</span>}
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
