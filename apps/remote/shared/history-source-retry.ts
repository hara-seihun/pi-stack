/** Native history changed between indexing and reading, not a broken transport. */
export function historySourceChanged(cause: unknown): boolean {
  const value = cause && typeof cause === "object" ? cause as { code?: unknown; message?: unknown } : null;
  const message = typeof cause === "string" ? cause : typeof value?.message === "string" ? value.message : "";
  const encoded = /(?:^|:\s)(stale[-_]source|conflict):\s([\s\S]+)$/.exec(message);
  const code = typeof value?.code === "string" ? value.code : encoded?.[1];
  if (code === "stale-source" || code === "stale_source") return true;
  const detail = encoded?.[2] ?? message;
  if (code === undefined) return /^(?:Could not (?:refresh thread|read transcript):\s)?Session (?:revision changed|(?:kept changing|changed|was rewritten or replaced).*(?:reading|indexing))/.test(detail);
  return code === "conflict" && /Session (?:revision changed|(?:kept changing|changed|was rewritten or replaced).*(?:reading|indexing))|refresh (?:the )?history index/.test(detail);
}
