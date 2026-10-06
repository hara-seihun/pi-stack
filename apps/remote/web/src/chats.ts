import type { ChatId } from "../../server/protocol";
import type { Room } from "../../shared/rooms";
export type { ChatId } from "../../server/protocol";
import type { MessagingBackendInfo, MessagingConversation, MessagingSnapshot } from "../../server/messaging/protocol";
import type { Session, ThreadStart } from "./types";
import { messagingAvatarUrl } from "./messaging-avatar";
import { conversationThreads } from "./thread-state";
import { attentionRank, threadStatus, roomThreadStatus, type ThreadStatus } from "./features/status/thread-status";
import { assertNever } from "../../shared/explicit-state";

export type Chat =
  | { id: ChatId; kind: "ai"; title: string; icon: string; label: string; session: Session }
  | { id: ChatId; kind: "room"; title: string; icon: string; label: string; room: Room }
  | { id: ChatId; kind: "human"; title: string; icon: string; label: string; /** The contact's or group's picture, when the backend has one. */ avatar?: string; conversation: MessagingConversation; backend?: MessagingBackendInfo };

export function aiChat(session: Session, starts: ThreadStart[]): Chat {
  const start = starts.find(candidate => candidate.id === session.environment);
  return { id: `ai:${session.id}`, kind: "ai", title: session.name || "Agent", icon: start?.icon || (["openai", "anthropic"].includes(session.provider) ? session.provider : "cloud"), label: start?.label || session.provider, session };
}

export function humanChat(conversation: MessagingConversation, backends: MessagingBackendInfo[]): Chat {
  const backend = backends.find(item => item.id === conversation.backendId);
  const avatar = messagingAvatarUrl(conversation.backendId, conversation.externalId, conversation.avatar);
  return { id: `human:${conversation.id}`, kind: "human", title: conversation.title, icon: backend?.icon || "cloud", label: backend?.label || conversation.backendId, ...(avatar ? { avatar } : {}), conversation, backend };
}

export function roomChat(room: Room): Chat {
  return { id: `room:${room.id}`, kind: "room", title: room.title, icon: "room", label: "Room", room };
}

export type InboxSection = "attention" | "working" | "quiet";
export const INBOX_SECTIONS: { id: InboxSection; label: string }[] = [
  { id: "attention", label: "Needs you" },
  { id: "working", label: "Active" },
  { id: "quiet", label: "Quiet" },
];

export interface InboxRow { chat: Chat; section: InboxSection; status: ThreadStatus | null; rank: number; updatedAt: number }

function humanStatus(conversation: MessagingConversation, backend?: MessagingBackendInfo): { section: InboxSection; rank: number } {
  if (conversation.unread > 0) return { section: "attention", rank: 3 };
  if (backend && backend.status !== "ready") return { section: "attention", rank: 4 };
  return { section: "quiet", rank: 22 };
}

export function inboxRow(chat: Chat): InboxRow {
  if (chat.kind === "ai") {
    const reported = threadStatus(chat.session);
    const notified = chat.session.idleUnread && Boolean(chat.session.attentionSummary);
    const status = notified ? { ...reported, attention: true } : reported;
    const rank = notified ? Math.min(2, attentionRank(status)) : attentionRank(status);
    const section: InboxSection = status.attention ? "attention" : status.busy ? "working" : "quiet";
    return { chat, section, status, rank, updatedAt: Date.parse(chat.session.updatedAt) || 0 };
  }
  if (chat.kind === "room") {
    const busy = chat.room.state === "running";
    const attention = (chat.room.unreadCount ?? 0) > 0 || (chat.room.pendingQuestions ?? 0) > 0;
    const reported = roomThreadStatus(chat.room);
    const status: ThreadStatus = { ...reported, attention: attention || reported.attention };
    return { chat, section: status.attention ? "attention" : busy ? "working" : "quiet", status, rank: reported.attention ? attentionRank(reported) : attention ? 3 : busy ? 10 : 22, updatedAt: chat.room.updatedAt ?? 0 };
  }
  if (chat.kind === "human") {
    const { section, rank } = humanStatus(chat.conversation, chat.backend);
    return { chat, section, status: null, rank, updatedAt: chat.conversation.updatedAt || 0 };
  }
  return assertNever(chat, "Inbox chat");
}

/** The inbox: every current chat, AI and human alike, ordered by what needs
 * the person first and by recency within a rank. Nothing here is stored;
 * the same inputs give the same list on every device. */
export function inboxRows(sessions: Session[], starts: ThreadStart[], messaging: MessagingSnapshot, rooms: Room[] = []): InboxRow[] {
  const chats = [...conversationThreads(sessions).map(session => aiChat(session, starts)), ...messaging.conversations.filter(item => item.current).map(item => humanChat(item, messaging.backends)), ...rooms.filter(room => room.current !== false).map(roomChat)];
  return chats.map(inboxRow).sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt || a.chat.title.localeCompare(b.chat.title));
}

export function currentChats(sessions: Session[], starts: ThreadStart[], messaging: MessagingSnapshot): Chat[] {
  return inboxRows(sessions, starts, messaging).map(row => row.chat);
}

/** Directly fetched rows bridge the gap until the authoritative directory carries them. */
export function reconcileDiscoveredSessions(discovered: Session[], sessions: Session[]): Session[] {
  const present = new Set(sessions.map(session => session.id));
  return discovered.filter(session => !present.has(session.id));
}

export interface ChatSnapshot { sessions: Session[]; messaging: MessagingSnapshot; rooms?: Room[] }
export function selectionAfterSync(selected: ChatId | null, previous: ChatSnapshot, next: ChatSnapshot): ChatId | null {
  const contains = (snapshot: ChatSnapshot) => snapshot.sessions.some(item => `ai:${item.id}` === selected) || snapshot.messaging.conversations.some(item => item.current && `human:${item.id}` === selected) || (snapshot.rooms ?? []).some(room => room.current !== false && `room:${room.id}` === selected);
  return contains(previous) && !contains(next) ? null : selected;
}

export function selectedAiId(state: { selectedChatId: ChatId | null }): string | null {
  return state.selectedChatId?.startsWith("ai:") ? state.selectedChatId.slice(3) : null;
}
