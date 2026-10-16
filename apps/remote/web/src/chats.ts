import type { ChatId } from "../../server/protocol";
import type { Room } from "../../shared/rooms";
export type { ChatId } from "../../server/protocol";
import type { Session, ThreadStart } from "./types";
import { agentName } from "./agent-name";
import { conversationThreads } from "./thread-state";
import { attentionRank, threadStatus, roomThreadStatus, type ThreadStatus } from "./features/status/thread-status";
import { assertNever } from "../../shared/explicit-state";

export type Chat =
  | { id: `ai:${string}`; kind: "ai"; title: string; /** The agent's first name, or null for threads the service never named. */ name: string | null; icon: string; label: string; session: Session }
  | { id: `room:${string}`; kind: "room"; title: string; icon: string; label: string; room: Room };

export function aiChat(session: Session, starts: ThreadStart[]): Chat {
  const start = starts.find(candidate => candidate.id === session.environment);
  return { id: `ai:${session.id}`, kind: "ai", title: session.name || "Agent", name: agentName(session), icon: start?.icon || (["openai", "anthropic"].includes(session.provider) ? session.provider : "cloud"), label: start?.label || session.provider, session };
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

export interface InboxRow { chat: Chat; section: InboxSection; status: ThreadStatus; rank: number; updatedAt: number; recencyAt: number }

export function inboxRow(chat: Chat): InboxRow {
  if (chat.kind === "ai") {
    const reported = threadStatus(chat.session);
    const notified = chat.session.idleUnread && Boolean(chat.session.attentionSummary);
    const status = notified ? { ...reported, attention: true } : reported;
    const rank = notified ? Math.min(2, attentionRank(status)) : attentionRank(status);
    const section: InboxSection = status.attention ? "attention" : status.busy ? "working" : "quiet";
    return { chat, section, status, rank, updatedAt: Date.parse(chat.session.updatedAt) || 0,
      recencyAt: Date.parse(chat.session.lastUserMessageAt ?? chat.session.createdAt) };
  }
  if (chat.kind === "room") {
    const busy = chat.room.state === "running";
    const attention = (chat.room.unreadCount ?? 0) > 0 || (chat.room.pendingQuestions ?? 0) > 0;
    const reported = roomThreadStatus(chat.room);
    const status: ThreadStatus = { ...reported, attention: attention || reported.attention };
    return { chat, section: status.attention ? "attention" : busy ? "working" : "quiet", status, rank: reported.attention ? attentionRank(reported) : attention ? 3 : busy ? 10 : 22, updatedAt: chat.room.updatedAt ?? 0, recencyAt: chat.room.updatedAt ?? 0 };
  }
  return assertNever(chat, "Inbox chat");
}

/** Current threads and rooms, ordered by attention and recency. */
export function inboxRows(sessions: Session[], starts: ThreadStart[], rooms: Room[] = []): InboxRow[] {
  const chats = [...conversationThreads(sessions).map(session => aiChat(session, starts)), ...rooms.filter(room => room.current !== false).map(roomChat)];
  return chats.map(inboxRow).sort((a, b) => a.rank - b.rank || b.recencyAt - a.recencyAt || a.chat.title.localeCompare(b.chat.title));
}

export function currentChats(sessions: Session[], starts: ThreadStart[], rooms: Room[] = []): Chat[] {
  return inboxRows(sessions, starts, rooms).map(row => row.chat);
}

/** Directly fetched rows bridge the gap until the authoritative directory carries them. */
export function reconcileDiscoveredSessions(discovered: Session[], sessions: Session[]): Session[] {
  const present = new Set(sessions.map(session => session.id));
  return discovered.filter(session => !present.has(session.id));
}

export interface ChatSnapshot { sessions: Session[]; rooms?: Room[] }
export function selectionAfterSync(selected: ChatId | null, previous: ChatSnapshot, next: ChatSnapshot): ChatId | null {
  const contains = (snapshot: ChatSnapshot) => snapshot.sessions.some(item => `ai:${item.id}` === selected) || (snapshot.rooms ?? []).some(room => room.current !== false && `room:${room.id}` === selected);
  return contains(previous) && !contains(next) ? null : selected;
}

export function selectedAiId(state: { selectedChatId: ChatId | null }): string | null {
  return state.selectedChatId?.startsWith("ai:") ? state.selectedChatId.slice(3) : null;
}
