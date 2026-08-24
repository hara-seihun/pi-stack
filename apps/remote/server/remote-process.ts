function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function processGroupCleanupCommand(file: string): string {
  return `f=${shellQuote(file)}; if test -f "$f"; then p=$(cat "$f" 2>/dev/null); test -n "$p" && kill -TERM -- -"$p" 2>/dev/null || true; sleep 0.15; test -n "$p" && kill -KILL -- -"$p" 2>/dev/null || true; rm -f "$f"; fi`;
}
