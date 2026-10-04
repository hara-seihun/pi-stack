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

test("a running conversation defaults to steer rather than waiting for the turn to finish", () => {
  const html = render({ session: { ...session, state: "running" }, prompt: "Adjust the work" });
  expect(html).toContain('aria-label="Change delivery. Current: Steer"');
  expect(html).not.toContain('aria-label="Change delivery. Current: Queued"');
});

test("offline status and reconnect take precedence even while a refresh is pending", () => {
  const offline = render({ syncing: true, offline: "Connection lost" });
  expect(header(offline)).toContain('data-status="offline"');
  expect(header(offline)).toContain("Reconnect");
  expect(header(offline)).not.toContain("Updating…");
  expect(offline).toContain("Cached conversation text");
});
