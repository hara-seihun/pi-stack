import type { MessagingConversation } from "../../server/messaging/protocol";

export const PICKER_INLINE_LIMIT = 8;
export const PICKER_RESULT_LIMIT = 20;

export function pickerOptions<T>(items: readonly T[], query: string, text: (item: T) => string) {
  const searchable = items.length > PICKER_INLINE_LIMIT;
  const needle = query.trim().toLocaleLowerCase();
  const matches = searchable ? items.filter(item => text(item).toLocaleLowerCase().includes(needle)) : items;
  return { searchable, total: matches.length, items: matches.slice(0, PICKER_RESULT_LIMIT) };
}

export function recentRecipients(conversations: readonly MessagingConversation[], backendId: string) {
  return conversations.filter(item => item.backendId === backendId)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** `812`, `9.9k`, `99k`: a token count at the precision a picker row can carry. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(tokens / 1_000)}k`;
}
