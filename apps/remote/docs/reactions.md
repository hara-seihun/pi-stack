# Message identity and reactions

[`message-protocol.ts`](../server/message-protocol.ts) defines the shared message identity and reaction data used by Pi conversation items and messaging history. An identity contains a stable `id`, the original message `timestamp` in epoch milliseconds, and a sender `id` with an optional display `name`. A reaction contains the emoji, its sender and event time. The client-facing `own` flag identifies reactions the current person can remove.

References keep their transport's identity rather than using a rendered text hash:

- `pi/THREAD_ID/NATIVE_ENTRY_ID` addresses a user or assistant entry in that thread's Pi JSONL.
- `messaging/MESSAGE_ID` addresses a confirmed message in the person's messaging database.
- `slack/WORKSPACE_ID/CHANNEL_ID/MESSAGE_TS` addresses the original Slack message. Reply root timestamps are passed separately as `threadTs`.

Each component is URI-encoded by `messageReference`. A rendered transcript item's content hash still addresses its immutable body; it is not a reaction target. Pending sends and live assistant text have no reaction controls until their source has a durable message identity.

## Model context

In ordinary Pi Remote mode, the context extension associates user and assistant messages with their native entry IDs and original timestamps. The current account's configured name and Unix ID identify locally authored user messages; the agent is Kenan. Structured sender metadata on imported messages takes precedence. A valid persisted `identity` on an imported message preserves its original transport reference. Text that merely looks like metadata does not change message identity.

The model receives message labels and the current system time at the start of each turn. Historical timestamps do not change when history is read again. These labels are request-only; native message bodies remain unchanged. Assistant labels use adjacent system updates so provider-signed text, thinking and tool calls remain intact. The mirror carries structured identity for the client without putting the labels into chat bubbles. Synthetic summaries without a native source or recorded sender get no invented identity. Raw mode loads none of these extensions.

## One reaction operation

The AI calls `message_react` with the target's message ID:

```json
{"messageId":"pi/THREAD_ID/NATIVE_ENTRY_ID","emoji":"❤️"}
```

Set `remove: true` to remove that actor's reaction where the transport supports it. The tool returns a confirmed result or a structured error. A lost connection or deadline reports an unconfirmed outcome rather than claiming that no reaction was sent. Reaction-looking XML inside a message remains text; there is no output-markup executor.

The browser and Android client call `POST /v1/messages/reactions`. The AI tool calls `POST /v1/sessions/:sessionId/reactions`, which attributes local reactions to Kenan rather than the human account. Both use [`reactToMessage`](../server/reactions.ts), the same request validation and transport dispatch. The account's supervisor resolves references; it does not accept arbitrary session-file paths or another person's message store.

Pi reactions live in `supervisor.sqlite3`'s `message_reactions` table, keyed by message, emoji and sender. Repeating an add is idempotent, and removing a reaction never removes another sender's reaction. The server validates the native target, pushes updated transcript heads to connected clients, and includes stored reactions in the next turn's context. Body hashes and stored message text do not change.

[Signal](messaging.md#reactions) sends and receives through the messaging plugin reaction contract. The service stores incoming events, including events that precede their target message, and publishes the same reaction data to the common renderer. Its linked account is the external reaction author, whether the request came from the UI or the AI.

[Slack](slack-reactions.md) delegates to the Work host's existing Converge command and preserves its permission and audience checks. That command currently supports adding reactions only. Its result confirms the requested reaction, not a complete Slack reaction history. Incoming Slack topics and their reaction history remain with Converge's Slack integration; this does not add a second Slack client or inbox to Remote.

The common message renderer provides reaction chips, actor names, an emoji picker and a remove toggle for owned reactions. It is shared by AI messages and Signal message groups.

## Focused checks

Run `bun test apps/remote/server/reactions.test.ts apps/remote/server/message-context.test.ts apps/remote/server/reaction-tools.test.ts apps/remote/server/context-mirror.test.ts apps/remote/server/messaging/service.test.ts apps/remote/server/messaging/signal.test.ts apps/remote/server/slack-reactions.test.ts apps/remote/web/chat-message.test.tsx`. These use local fixtures, not real Slack or Signal recipients.
