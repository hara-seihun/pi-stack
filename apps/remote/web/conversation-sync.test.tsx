import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../server/protocol";
import { ConversationScreen } from "./src/features/conversation/ConversationScreen";

// Artwork paths derive from the page address; there is no page here.
globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const session: Session = {
  id: "thread", parentId: null, hasChildren: false, origin: "person", model: "model", name: "Thread",
  cwd: "/", workspaceName: "", environment: "local", state: "idle", held: false, activity: "idle", activeTools: [],
  provider: "openai", createdAt: "", updatedAt: "2026-01-01T00:00:00Z", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null,
};

const props: Parameters<typeof ConversationScreen>[0] = {
  session, ancestors: [], entries: [
    { kind: "user", key: "cached-message", signature: "cached-message", text: "Earlier message" },
    { kind: "notice", key: "cached-note", signature: "cached-note", text: "Cached conversation text" },
  ],
  liveText: "", liveThinking: "", thinkingActive: false, images: null, offline: "", pending: false,
  home: "/", prompt: "", attachments: [], slashCommands: [],
  drawing: { isOpen: false, open() {}, editImage() {}, editors: null },
  uploadError: "", controlError: "", earlierAvailable: false, loadingEarlier: false, earlierError: "",
  onShowEarlier() {}, onThinkingOpen() {}, onBack() {}, onOpenInspector() {}, onOpenAncestor() {}, onOpenQueue() {},
  questions: [], onQuestionAccepted() {}, onEdit() {}, reply: null, onReply() {}, onCancelReply() {},
  onPrompt() {}, onSend() {}, onStop() {}, onResume() {}, onReconnect() {}, onRemoveAttachment() {},
  onUpload() {}, onPaste() {}, onDraw() {}, onDismissControlError() {}, showBack: true,
};

function render(patch: Partial<typeof props> = {}) {
  return renderToStaticMarkup(<ConversationScreen {...props} {...patch} />);
}

function header(html: string) {
  return html.match(/<header class="conversation-header">.*?<\/header>/s)?.[0] ?? "";
}

test("cached idle transcript stays visible while the header updates, then idle returns when ready", () => {
  const updating = render({ syncing: true });
  expect(header(updating)).toContain('class="conversation-syncing" role="status"');
  expect(header(updating)).toContain("Updating…");
  expect(header(updating)).toContain('class="conversation-syncing-spinner" aria-hidden="true"');
  expect(header(updating)).not.toContain("Idle");
  expect(updating).toContain('class="message user"');
  expect(updating).toContain("Cached conversation text");

  const ready = render({ syncing: false });
  expect(header(ready)).toContain('data-status="idle"');
  expect(header(ready)).toContain("Idle");
  expect(header(ready)).not.toContain("Updating…");
  expect(ready).toContain("Cached conversation text");
});

test("chat header consumes context usage and replaces a count with recalculating or unavailable", () => {
  const measured = { ...session, contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 } };
  expect(header(render({ session: measured }))).toContain("~12.3K tok");
  const recalculating = header(render({ session: { ...measured, contextUsage: { ...measured.contextUsage, tokens: null, percent: null } } }));
  expect(recalculating).toContain("Context …");
  expect(recalculating).not.toContain("~12.3K tok");
  expect(header(render())).toContain("Context —");
});

test("a running conversation defaults to steer rather than waiting for the turn to finish", () => {
  const html = render({ session: { ...session, state: "running" }, prompt: "Adjust the work" });
  expect(html).toContain('aria-label="Change delivery. Current: Steer"');
  expect(html).not.toContain('aria-label="Change delivery. Current: Queued"');
});

test("questions replace messaging, expose only the next answer, and preserve dictation and stop", () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  Object.assign(globalThis, { window: { PiRemotePerson: { get: () => "person" } }, localStorage: { getItem: () => null } });
  try {
    const html = render({ session: { ...session, state: "running" }, prompt: "Unsent message", questions: [
      { id: "q1", threadId: "thread", question: "Which option?", createdAt: 1, suggestions: [{ id: "a", text: "Choice A" }], recommendedSuggestionId: "a" },
      { id: "q2", threadId: "thread", question: "Second question", createdAt: 2, suggestions: [] },
    ] });
    expect(html).not.toContain('id="prompt"');
    expect(html).not.toContain("Unsent message");
    expect(html).toContain('aria-label="Submit answer"');
    expect(html).toContain('aria-label="Start dictation"');
    expect(html).toContain("Dismiss question");
    expect(html).toContain("Stop thread");
    expect(html).toContain("Recommended");
    expect(html).not.toContain("Second question");
    expect(html).not.toContain('checked=""');
    expect(render({ prompt: "Unsent message" })).toContain("Unsent message");
  } finally { Object.assign(globalThis, { window: originalWindow, localStorage: originalStorage }); }
});

test("offline status and reconnect take precedence even while a refresh is pending", () => {
  const offline = render({ syncing: true, offline: "Connection lost. Reconnecting…" });
  expect(header(offline)).toContain('data-status="offline"');
  expect(header(offline)).toContain("Connection lost. Reconnecting…");
  expect(header(offline)).toContain("Reconnect");
  expect(header(offline)).not.toContain("Updating…");
  expect(offline).toContain("Cached conversation text");
});
