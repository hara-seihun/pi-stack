# Shared web client

React and TypeScript client for browsers and the [Kenan Android shell](../../kenan/README.md). Both use the same conversation, rooms, drawing, files, settings and Machine components. The [development catalogue](src/ui-catalogue/README.md) renders synthetic states without live personal data.

## Navigation and identity

[`Shell`](src/app/Shell.tsx) has five hash-routed destinations: Chats, Agents, Files, Machine and Settings. Below 900px it presents one pane and a bottom tab bar; wider screens have an icon rail, list and detail. Inspector and queue routes close through browser history or [`system-back.ts`](src/app/system-back.ts). Old worker links open their original thread under Chats.

[`native.ts`](src/native.ts), [`person.ts`](src/person.ts) and [`router-auth.ts`](src/router-auth.ts) own authenticated endpoint selection, person-session bootstrap and native session synchronization. Identity changes abort outstanding requests and fence late results. Cookies restore browser router sessions; authenticated API and file requests retain the router-session contract. Endpoint grants do not grant another person's private state.

Thread titles come from the owner. Agents and their launchers are presented by task title and thread ID. The assistant is Kenan. The Agents directory loads `GET /v1/sessions?allAgents=1`, with activity filters and search; opening an agent selects its existing conversation. Manual thread model, thinking, speed and timeout settings remain in the inspector.

## Conversations and rooms

Chats combines persistent AI conversations and shared human rooms. Inbox order uses attention and accepted human-message recency, with unread main-agent notices first. Closing and reopening use owner operations; they do not create another conversation. Rooms use the same composer, message renderer, uploads and drawing controller.

[`ConversationScreen`](src/features/conversation/ConversationScreen.tsx) sends one prompt operation. [`prompt-outbox.ts`](src/prompt-outbox.ts) persists the exact request identity before transport and retries uncertain submissions under that identity. Historical outbox payload fields remain intact for receipt replay. The queue sheet permits editing or cancelling undispatched input, and explains unconfirmed acceptance without offering a new dispatch.

The empty composer exposes Stop when work is active; typed text exposes Send. Pending questions replace ordinary messaging until independently answered or dismissed, without losing the draft. User input receipts distinguish sending, accepted, consumed and terminal outcomes. A completed turn is an execution receipt, not an inference that its larger task is complete.

The manager view keeps human and Kenan chat bubbles separate from Work. Complete durable replies enter its timeline at finalization; the typing bubble opens the turn's tools, thinking and agent exchanges. Classic view exposes chronological execution detail. Agent exchanges link to original thread IDs/task titles, not generated personal names.

Uploads, pasted documents and drawings attach to the draft without sending. Image drawing preserves the original pixel dimensions and retains failed uploads for retry. Attachment drafts belong to their conversation. Touch keyboards use Enter for a newline; hardware keyboards can send with Enter.

## The stream

[`client.ts`](src/client.ts) reconciles finite snapshots before attaching a disposable push stream. [`shared/reconcile.ts`](../shared/reconcile.ts) validates revisions and content hashes before replacing retained state. A missing patch base asks for a complete resource. Connection status reflects successful finite synchronization, not merely an open socket.

Foreground, network and focus transitions coalesce into reconciliation. Hidden ordinary views release feeds and timers; external Meet owns its media lifecycle. Current selection acknowledgements fence old responses. Cached history remains readable during recovery while its header shows Updating or the concrete failure.

Resource subscriptions follow the visible route: selected transcript, images and questions; Machine only while open; thinking only while disclosed. Native notification leases hand off durable cursors without duplicate stream/poll delivery. Every person/environment retains its own notification cursor.

[`client-cache.ts`](src/client-cache.ts) and [`transcript-cache.ts`](src/transcript-cache.ts) retain byte-bounded heads and immutable bodies. Exact text loads on disclosure/copy. Native history remains authoritative; live text is a disposable projection. Virtualized transcript anchors preserve the reading position through streaming and late media, and Jump to latest explicitly resumes following.

## Notifications

[`notification-control.tsx`](src/notification-control.tsx) remains mounted across destinations. The server's explicit `manager` flag identifies Kenaznia/main-agent notices. These become persistent, highest-layer in-app banners even when their conversation is selected or browser notification permission is disabled. Open selects the original environment/thread; Dismiss removes that displayed notice. Main notices are deduplicated by person, environment and sequence, and queued rather than overwritten.

Other enabled notifications use ordinary transient toasts while visible and OS notifications in the background. Settings controls browser permission; Android permission acquisition belongs to its native entry gate. Notifications from all granted environments are monitored independently of the current endpoint. Main OS notices request persistent interaction when the browser supports it.

## Files and images

[`FilesScreen`](src/features/files/FilesScreen.tsx) exchanges the authenticated editor ticket through a POST form into a bare iframe. [`editor-launch.ts`](src/features/files/editor-launch.ts) validates the explicit editor URL/ticket and fences identity changes. While the editor is open, Pi Stack navigation and sheets are hidden without remounting the iframe. The router binds frame permission to the authenticated app origin. Android uses its retained top-level isolated WebView, bare once ready, so private HTTP editor cookies do not become cross-site under the bundled localhost origin. Filesystem browsing and editing belong to code-server; authenticated exact-path attachments and conversation artifact previews retain their existing routes.

[`inline-images.ts`](src/inline-images.ts) renders the same durable image record for a path or a generation prompt. A source path is registered by the server's custody owner, not read directly from a model tag by the client. The renderer shows custody-backed output, progress or failure. [Inline media](../docs/inline-images.md) owns the tag and file-route contracts.

## Machine and settings

[`MachineScreen`](src/features/machine/MachineScreen.tsx) projects the dashboard into [`MachineRow`](src/features/machine/rows.tsx): label, value, detail, importance, tone, optional action and child rows. One shared renderer orders rows by importance and discloses secondary data. Errors, exhausted limits and connection failures precede routine telemetry. Missing measurements display explicitly rather than becoming zero. Provider/account quotas, reset freshness, usage cost, people, host and feature analytics use the same row schema.

[`FeatureUsage`](src/features/machine/FeatureUsage.tsx) contributes measured analytics rows rather than a second dashboard layout. Settings retains manual conversation preferences, notifications, endpoint selection, app updates and phone controls. Android's native SetupGate owns every permission grant; the web only consumes `phoneStatus.setup.state` (`complete` or `needs-permissions`) and controls service enabled/overlay preferences after setup.

## Dismissible errors and toasts

Server errors retain occurrence IDs and explicit dismissal acknowledgements. A failed acknowledgement leaves the error available for retry; it does not claim the failed operation succeeded. [`toasts.tsx`](src/toasts.tsx) owns transient notices for errors and completed actions. Kenaznia notices use their separate persistent priority banner.

## Development

Use the workspace's existing dependencies and build commands. `bun test apps/remote/web` runs focused client contracts; `app-path.test.ts` also requires a built `web/dist`. The repository build owns emitted assets and TypeScript declarations. The catalogue is a loopback-only synthetic workbench, not a production navigation destination.
