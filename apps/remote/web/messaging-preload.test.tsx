import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessagingMessage, MessagingSnapshot } from "../server/messaging/protocol";
import { MessagingConversations } from "./src/Messages";
import { MessagingHistoryCache } from "./src/messaging-history";

test("first render of a never-visited Signal thread already contains its preloaded messages", async () => {
  const snapshot: MessagingSnapshot = { version: 1, backends: [], calls: [], conversations: [{
    id: "chat", backendId: "signal", externalId: "contact", title: "Contact", kind: "direct", updatedAt: 1, unread: 1, current: true, avatar: null,
  }] };
  const message: MessagingMessage = {
    id: "message", requestId: null, conversationId: "chat", externalId: "external", direction: "incoming", sender: "Contact",
    text: "Already here before the tap", timestamp: 1, status: "received", error: null, attachments: [],
  };
  let requests = 0;
  const history = new MessagingHistoryCache(async () => { requests++; return { ok: true, value: { messages: [message], before: 7 } }; });
  history.reconcile(snapshot);
  await Promise.resolve();
  let reads = 0;
  const html = renderToStaticMarkup(<MessagingConversations selected={snapshot.conversations[0]} snapshot={snapshot} history={history} onRead={() => { reads++; }} />);
  expect(html).toContain(message.text);
  expect(html).toContain("Older messages");
  expect(html).not.toContain("Loading conversation");
  expect(requests).toBe(1);
  expect(reads).toBe(0);
  history.dispose();
});
