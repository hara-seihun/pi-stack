import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../server/protocol";
import { InspectorSheet } from "./src/features/inspector/InspectorSheet";

const thread: Session = {
  id: "consumer", parentId: null, hasChildren: false, origin: "person", model: "openai/astra",
  name: "Consumer", cwd: "/home", workspaceName: "Home", environment: "home", state: "waiting",
  held: false, activity: "awaiting", activityDetail: "Waiting for agent results", dependencies: ["producer"],
  activeTools: [], provider: "openai", createdAt: "", updatedAt: "", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null,
};
const noop = () => {};
const render = (session: Session, pending = false) => renderToStaticMarkup(<InspectorSheet
  session={session} sessions={[]} open pending={pending} autoCollapse onAutoCollapseChange={noop}
  onClose={noop} onOpenThread={noop} onOpenThreadId={noop} onArchive={noop} onRestore={noop} onBackground={noop}
/>);

test("the permanent manager hides archive and background actions in the shared inspector", () => {
  const html = render({ ...thread, manager: true, foreground: true });
  expect(html).not.toContain("Close agent");
  expect(html).not.toContain("Move to background");
  expect(html).not.toContain("<dt>Close</dt>");
  expect(html).toContain("Activity");
  expect(render({ ...thread, foreground: true })).toContain("Move to background");
});

test("waiting references never disable Close or create a second dependency status", () => {
  for (const session of [thread, { ...thread, waitingOnAgents: { kind: "agents" as const, threadIds: ["producer"], after: {}, reason: "Result", since: 1 } }]) {
    const html = render(session);
    expect(html).toContain('<button type="button">Close agent</button>');
    expect(html.match(/class="status-pill" data-status="waiting"/g)).toHaveLength(1);
    expect(html).toContain("producer");
    expect(html).not.toContain("Dependencies</h3>");
    expect(html).not.toContain("before closing");
  }
  const pending = render(thread, true);
  expect(pending).toContain('<button type="button" disabled="">Close agent</button>');
  expect(pending).toContain("Unavailable while an action is finishing");
});
