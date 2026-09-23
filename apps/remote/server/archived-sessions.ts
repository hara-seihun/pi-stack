interface ArchivedSessionRow {
  id: string;
  name: string;
  parentId?: string | null;
  archived_at: string | null;
  updatedAt: number;
}

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export function archivedSessions<T extends ArchivedSessionRow>(
  rows: readonly T[],
  params: URLSearchParams,
  isPersonThread: (id: string) => boolean,
) {
  const offset = Math.max(0, Math.floor(Number(params.get("offset") ?? 0) || 0));
  const requested = Math.floor(Number(params.get("limit") ?? PAGE_SIZE) || PAGE_SIZE);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));
  const query = params.get("query")?.trim().toLowerCase();
  const conversationsOnly = params.get("conversationsOnly") === "true";
  const matches = rows.filter(row => row.archived_at
    && (!conversationsOnly || (!row.parentId && isPersonThread(row.id)))
    && (!query || row.name.toLowerCase().includes(query)));
  matches.sort(params.has("query") || conversationsOnly
    ? (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
    : (a, b) => String(b.archived_at).localeCompare(String(a.archived_at)));
  const sessions = matches.slice(offset, offset + limit);
  return { sessions, total: matches.length, offset, limit, hasMore: offset + sessions.length < matches.length };
}
