import type { MessageIdentity, MessageReaction, MessageReply } from "../message-protocol.js";

export type MessagingResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface MessagingCapabilities {
  attachments: boolean;
  groups: boolean;
}

export interface MessagingBackendInfo {
  id: string;
  label: string;
  plugin: "signal";
  icon: string;
  capabilities: MessagingCapabilities;
  status: "ready" | "unconfigured" | "connecting" | "error";
  detail: string;
  /** The backend supports agent account provisioning through device linking. */
  linkable: boolean;
  /** The current or last device-link attempt, or null when none has run. */
  link: MessagingLink | null;
}

/** A device-link attempt. `waiting` exposes the URI while the primary device accepts it. */
export interface MessagingLink {
  status: "waiting" | "linked" | "failed" | "cancelled";
  /** The `sgnl://linkdevice` URI to scan or open, while waiting. */
  uri: string | null;
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
  /** Rises whenever anything a client renders for one of this conversation's messages changes. */
  revision: number;
}

export interface MessagingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface MessagingMessage {
  id: string;
  /** Database history cursor; absent on unsaved optimistic messages. */
  seq?: number;
  requestId: string | null;
  conversationId: string;
  externalId: string | null;
  direction: "incoming" | "outgoing";
  sender: string;
  senderName?: string;
  text: string;
  timestamp: number;
  status: "received" | "sending" | "sent" | "failed" | "unknown";
  error: string | null;
  /** Shared owner-bound dispatch authority, not a retry identity. */
  actionId?: string;
  attachments: MessagingAttachment[];
  identity?: MessageIdentity;
  reactions?: MessageReaction[];
  reply?: MessageReply;
}

export interface MessagingSnapshot {
  version: number;
  backends: MessagingBackendInfo[];
  conversations: MessagingConversation[];
}
export interface MessagingHistory {
  messages: MessagingMessage[];
  before: number | null;
  /** The conversation revision this window reflects; pass it as `after` to fetch only later changes. */
  revision: number;
}
/** Messages at or after the client's oldest held message that changed or disappeared after its revision. */
export interface MessagingHistoryChanges {
  messages: MessagingMessage[];
  removed: string[];
  revision: number;
}
export interface MessagingPurpose {
  /** Stable accountable purpose; absent uses a digest of recipient and effect bytes. */
  intentKey?: string;
  /** Accountable new effect, atomically releasing a settled prior purpose. */
  followup?: { actionId: string; revision: number; evidence: string };
}
export interface MessagingSend extends MessagingPurpose {
  requestId: string;
  text: string;
  attachmentIds: string[];
  /** Universal `messaging/<local-message-id>` reference in this conversation. */
  replyTo?: string;
}
export interface MessagingBackendConfig {
  id: string;
  plugin: "signal";
  label: string;
  options?: Record<string, unknown>;
}
