import { useState } from "react";
import { Shell, TabNav } from "../app/Shell";
import { useLayout } from "../app/layout";
import { TABS, type Tab } from "../app/routes";
import { Sheet } from "../app/Sheet";
import type { UiCase } from "./contract";

function ShellFixture({ detail, single, badges, update }: { detail: boolean; single: boolean; badges: boolean; update: boolean }) {
  const layout = useLayout();
  const [active, setActive] = useState<Tab>("chats");
  return <Shell layout={layout} showDetail={detail} showTabs={single || !detail}
    nav={<TabNav layout={layout} active={active} onSelect={setActive}
      badges={badges ? { chats: { count: 124, attention: true }, agents: { count: 12 } } : {}}
      update={update ? { visible: true, busy: false, status: "New version ready", onClick: () => setActive("settings") } : undefined} />}
    list={single ? null : <section className="empty-state"><strong>{active === "chats" ? "Chats" : active}</strong><span>No conversations yet</span></section>}
    detail={<section className="empty-state"><strong>{detail ? "Selected conversation" : "Choose a conversation"}</strong><span>{detail ? "Back returns to the inbox." : "Your conversations appear here."}</span></section>} />;
}

function SheetFixture({ nested }: { nested: boolean }) {
  const [open, setOpen] = useState(true);
  return <><ShellFixture detail={false} single={false} badges={false} update={false} />
    {open && <Sheet open title={nested ? "Details — Unicode 日本語 العربية 🌿" : "Details"} onClose={() => setOpen(false)}>
      <section className="empty-state"><strong>Details</strong><span>Close returns to the underlying screen.</span><button className="accent" onClick={() => setOpen(false)}>Done</button></section>
    </Sheet>}
  </>;
}

export const shellCases: UiCase[] = [
  ...TABS.map(tab => ({ id: `navigation-${tab}`, title: `Navigation: ${tab}`, component: "TabNav", contract: "Tab + responsive Layout; badges count > 99 caps visually", boundary: "finite-variant" as const,
    render: () => <NavigationFixture initial={tab} /> })),
  { id: "shell-list", title: "List and empty detail", component: "Shell", contract: "list non-null; showDetail false", boundary: "composition", render: () => <ShellFixture detail={false} single={false} badges={false} update={false} /> },
  { id: "shell-detail", title: "Selected conversation", component: "Shell", contract: "list non-null; showDetail true; phone tabs hidden", boundary: "composition", render: () => <ShellFixture detail single={false} badges={false} update={false} /> },
  { id: "shell-single", title: "Top-level single pane", component: "Shell", contract: "list null; showDetail true; showTabs true", boundary: "composition", render: () => <ShellFixture detail single badges update={false} /> },
  { id: "shell-update-badges", title: "Update and capped attention badges", component: "Shell,TabNav", contract: "positive badge counts; offered app update", boundary: "content-boundary", render: () => <ShellFixture detail={false} single={false} badges update /> },
  { id: "shell-sheet", title: "Sheet above list", component: "Sheet", contract: "responsive Layout + dismissible overlay", boundary: "composition", render: () => <SheetFixture nested={false} /> },
  { id: "shell-sheet-unicode", title: "Sheet title Unicode", component: "Sheet", contract: "unbounded title generating class: Unicode", boundary: "content-boundary", render: () => <SheetFixture nested /> },
];

function NavigationFixture({ initial }: { initial: Tab }) {
  const layout = useLayout();
  const [active, setActive] = useState(initial);
  return <Shell layout={layout} showDetail showTabs list={null}
    nav={<TabNav layout={layout} active={active} badges={{ chats: { count: 102, attention: true }, agents: { count: 1 } }} onSelect={setActive} />}
    detail={<section className="empty-state"><strong>{active}</strong><span>Each section remains reachable by touch and keyboard.</span></section>} />;
}
