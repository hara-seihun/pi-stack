# Message replies

Pi and Signal messages share `MessageReply` in [`message-protocol.ts`](../server/message-protocol.ts): an original message ID, sender, preview and optional timestamp. A received quote can have a null ID when the original is unavailable locally. Its preview still renders, but cannot jump to an original.

The shared web message menu offers Reply and React on long press or right-click. Focused messages also support the keyboard context-menu key or Shift+F10. There are no inline Reply or add-reaction buttons; existing reaction badges remain visible. The composer shows the selected quote and lets the user cancel it. Sending passes only `replyTo`, using the same message references as reactions. The server resolves the original; client-supplied preview text is not trusted. Clicking a quote jumps to a loaded original. Otherwise the UI reports that it is not loaded.

Pi prompt requests accept references from the same conversation. The supervisor reads the exact native history entry and quotes user or assistant messages, with previews capped at 4,000 characters. [`message-replies.ts`](../server/message-replies.ts) encodes the reference and preview at the beginning of the native user input. This keeps the quote with the actual message through persistence, restart and fork, and supplies the model with the quoted context. The display projection strips that envelope and attaches the structured quote to the transcript head. It does not rewrite stored history.

[Signal replies](messaging.md) preserve incoming author/timestamp/text and resolve a universal message reference when the target is stored. Outgoing replies use Signal's native quote fields. The messaging store retains unresolved quotes and resolves them when the original arrives. Messages received before quote persistence was installed cannot recover discarded quote metadata from their stored text.

Focused proofs are in `server/message-replies.test.ts`, the messaging service and Signal tests, and `web/chat-message.test.tsx` and `web/messaging.test.ts`. No live message send is needed for those tests.
