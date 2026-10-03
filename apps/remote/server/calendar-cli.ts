import { phoneEndpoint } from "./phone-cli";

export const CALENDAR_HELP = `usage: pi-calendar OPERATION [OPTIONS]
  list [--from ISO --to ISO]           Agenda (default: next 180 days)
  add --title TEXT --start ISO --end ISO --zone IANA [--location TEXT --notes TEXT --all-day]
  update ID [event options]            Change an owned event
  delete ID                           Delete an owned event
  zone IANA                           Set calendar display/default subscription zone
  feed                                Private subscription URL (treat as a secret)
  rotate-feed                         Revoke the old feed URL
  subscribe --name TEXT --url URL [--zone IANA]
  unsubscribe ID
  refresh                             Refresh all inbound ICS subscriptions

All output is JSON. ISO times without an offset are interpreted in --zone;
ambiguous/nonexistent DST times require an offset. All-day end dates are exclusive.
Imported events are read-only. No automatic mutation retries.
Endpoint: PI_CALENDAR_URL or PI_REMOTE_SERVER_URL, otherwise your own supervisor.
Router access uses PI_REMOTE_SESSION; local access uses the UID-bound transport.
`;
export function calendarInvocation(argv: string[]): { ok: true; path: string; method: string; body?: Record<string, unknown> } | { ok: false; error: string } {
  const [op, ...args] = argv; const options: Record<string, unknown> = {}; const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--all-day") { options.allDay = true; continue; }
    if (key === "--json") continue;
    if (!key.startsWith("--")) { positional.push(key); continue; }
    if (!["title", "start", "end", "zone", "location", "notes", "from", "to", "url", "name"].includes(key.slice(2)) || !args[i + 1] || args[i + 1]!.startsWith("--")) return { ok: false, error: `Unknown or incomplete option ${key}` };
    options[key.slice(2)] = args[++i]!;
  }
  const base = "/v1/calendar";
  if (op === "list" && !positional.length) { const q = new URLSearchParams(); for (const key of ["from", "to"]) if (options[key]) q.set(key, String(options[key])); return { ok: true, path: `${base}?${q}`, method: "GET" }; }
  if (op === "add" && !positional.length) return { ok: true, path: `${base}/events`, method: "POST", body: options };
  if (op === "update" && positional.length === 1) return { ok: true, path: `${base}/events/${encodeURIComponent(positional[0]!)}`, method: "PATCH", body: options };
  if (["delete", "unsubscribe"].includes(op!) && positional.length === 1) return { ok: true, path: `${base}/${op === "delete" ? "events" : "subscriptions"}/${encodeURIComponent(positional[0]!)}`, method: "DELETE" };
  if (op === "zone" && positional.length === 1) return { ok: true, path: `${base}/settings`, method: "PUT", body: { zone: positional[0] } };
  if (["feed", "rotate-feed", "refresh", "subscribe"].includes(op!) && !positional.length) return { ok: true, path: `${base}/${op === "subscribe" ? "subscriptions" : op === "rotate-feed" ? "feed" : op}`, method: op === "feed" ? "GET" : "POST", body: op === "subscribe" ? options : {} };
  return { ok: false, error: "Invalid operation; run pi-calendar --help" };
}
export async function runCalendarCli(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") { console.log(CALENDAR_HELP); return 0; }
  const invocation = calendarInvocation(argv); if (!invocation.ok) { console.error(invocation.error); return 1; }
  const endpoint = phoneEndpoint({ ...process.env, PI_PHONE_URL: process.env.PI_CALENDAR_URL });
  if (!endpoint.ok) { console.error(endpoint.message); return 1; }
  try {
    const response = await fetch(endpoint.url + invocation.path, { method: invocation.method, headers: endpoint.headers, ...(invocation.body ? { body: JSON.stringify(invocation.body) } : {}), signal: AbortSignal.timeout(65000) });
    console.log(JSON.stringify(await response.json(), null, 2)); return response.ok ? 0 : 1;
  } catch { console.error(invocation.method === "GET" ? "Calendar transport failed" : "Calendar transport failed; the mutation may have executed. Inspect before retrying."); return 1; }
}
if (import.meta.main) process.exitCode = await runCalendarCli(process.argv.slice(2));
