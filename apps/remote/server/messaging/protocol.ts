import type { MessageIdentity, MessageReaction, MessageReply } from "../message-protocol.js";

export type MessagingResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface MessagingCapabilities {
  attachments: boolean;
  groups: boolean;
  calls: boolean;
}

export type MessagingCallState =
  | "ringing_incoming"
  | "ringing_outgoing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended";

export interface MessagingCall {
  /** PiStack's own id for this call, used in every call route. */
  id: string;
  backendId: string;
  /** PiStack conversation row id; the call belongs in that chat. */
  conversationId: string;
  /** Stable peer address, as `MessagingMessage.sender` uses. */
  peer: string;
  peerName: string | null;
  /** Picture version for the avatar route, or null. */
  avatar: number | null;
  direction: "incoming" | "outgoing";
  state: MessagingCallState;
  /** The browser is not sending microphone audio. Server-owned, survives reconnect. */
  muted: boolean;
  startedAt: number;
  connectedAt: number | null;
  endedAt: number | null;
  /** Backend reason for an ended call, for example `remote_hangup`, `ring_timeout`. */
  reason: string | null;
  /** A definite failure to place or accept, for display. */
  error: string | null;
}

export interface MessagingBackendInfo {
  id: string;
  label: string;
  plugin: string;
  icon: string;
  capabilities: MessagingCapabilities;
  status: "ready" | "unconfigured" | "connecting" | "error";
  detail: string;
  /** The backend can link an account from the app. */
  linkable: boolean;
  /** The current or last device-link attempt, or null when none has run. */
  link: MessagingLink | null;
}

/**
 * A device-link attempt. `waiting` means the app is showing `uri` and its `qr`
 * rendering and the backend is waiting for the account owner to scan it.
 */
export interface MessagingLink {
  status: "waiting" | "linked" | "failed" | "cancelled";
  /** The `sgnl://linkdevice` URI to scan or open, while waiting. */
  uri: string | null;
  /** Inline SVG for `uri`, or null when this host cannot render one. */
  qr: string | null;
  deviceName: string;
  /** The linked account, once the primary device accepts. */
  account: string | null;
  error: string | null;
  updatedAt: number;
}

export interface MessagingConversation {
  id: string;
  backendId: string;
  externalId: string;
  title: string;
  kind: "direct" | "group";
  updatedAt: number;
  unread: number;
  current: boolean;
  /** Version of the contact's or group's picture, for the avatar route; null when the backend has none. */
  avatar: number | null;
}

export interface MessagingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface MessagingLinkPreview {
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export interface MessagingMessage {
  id: string;
  requestId: string | null;
  conversationId: string;
  externalId: string | null;
  direction: "incoming" | "outgoing";
  sender: string;
  senderName?: string;
  /** Version of the sender's picture, for the avatar route. Absent when the backend has none. */
  senderAvatar?: number;
  text: string;
  timestamp: number;
  status: "received" | "sending" | "sent" | "failed" | "unknown";
  error: string | null;
  attachments: MessagingAttachment[];
  identity?: MessageIdentity;
  reactions?: MessageReaction[];
  reply?: MessageReply;
}

export interface MessagingSnapshot {
  version: number;
  backends: MessagingBackendInfo[];
  conversations: MessagingConversation[];
  calls: MessagingCall[];
}
export interface MessagingHistory {
  messages: MessagingMessage[];
  before: number | null;
}
export interface MessagingSend {
  requestId: string;
  text: string;
  attachmentIds: string[];
  /** Universal `messaging/<local-message-id>` reference in this conversation. */
  replyTo?: string;
}
export interface MessagingBackendConfig {
  id: string;
  plugin: string;
  label: string;
  options?: Record<string, unknown>;
}
