import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { API } from "./api";
import { parseMessageReference } from "./message-protocol";
import type { MessagingSend } from "./messaging/protocol";

export const SIGNAL_HELP = `usage: pi-signal OPERATION [ARGS]

  list                                  Configured own-person Signal profiles and directory
  open PROFILE TARGET                   Resolve a contact/number/username/group
  read CONVERSATION [--before N] [--limit 1..100]
  send CONVERSATION TEXT|- --request-id ID [--reply-to MESSAGE_ID] [--attachment ID ...]
  react MESSAGE_ID EMOJI --request-id ID [--remove]
  upload CONVERSATION PATH               Stage an attachment in the encrypted own-person store
  download ATTACHMENT_ID --output PATH   Save owned attachment bytes
  remove-attachment ATTACHMENT_ID        Remove an unsent staged attachment
  link PROFILE DEVICE_NAME              Begin authorized linked-device provisioning; returns URI
  cancel-link PROFILE                   Cancel pending provisioning

Signal is an agent tool, not a Pi Stack chat or call product. No calls or automatic retries.
Use only an authorized account/recipient. Profile identity never comes from a person argument.
Local shell identity is the Unix UID at the loopback router; a Pi session uses its own supervisor
and PI_THREAD_TOKEN. A locked/unconfigured account is an error, never another person's identity.
Send/react require a stable request ID chosen BEFORE dispatch. Reuse exactly the same ID and
payload to inspect/recover a lost acknowledgement; changed payloads conflict. A 202 send means
accepted into the durable outbox, not delivery. Read history for its sent/failed/unknown outcome.
Unknown outcomes may have executed. Inspect first; never issue a new ID as an automatic retry.
Outgoing actions are journaled by the encrypted transport owner, not duplicated by this CLI.
`;

type Invocation = { path: string; method: string; json?: Record<string, unknown>; file?: string; output?: string; requestId?: string };
type Parsed = { ok: true; value: Invocation | null } | { ok: false; error: string };
export function parseSignalArgs(argv: string[], stdin = () => readFileSync(0, "utf8")): Parsed {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") return { ok: true, value: null };
  const args: string[] = []; const attachments: string[] = []; const options: Record<string, string> = {}; let remove = false;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === "--") { args.push(...argv.slice(i + 1)); break; }
    if (value === "--remove") { if (remove) return { ok: false, error: "Duplicate --remove" }; remove = true; continue; }
    if (["--request-id", "--reply-to", "--attachment", "--before", "--limit", "--output"].includes(value)) {
      const next = argv[++i];
      if (!next || next.startsWith("--")) return { ok: false, error: `${value} requires a value` };
      if (value === "--attachment") attachments.push(next);
      else if (options[value] !== undefined) return { ok: false, error: `Duplicate ${value}` };
      else options[value] = next;
    } else if (value.startsWith("--")) return { ok: false, error: `Unknown option ${value}` };
    else args.push(value);
  }
  const [operation, id, text] = args;
  const allowedOptions: Record<string, string[]> = { list: [], open: [], read: ["--before", "--limit"], send: ["--request-id", "--reply-to"], react: ["--request-id"], upload: [], download: ["--output"], "remove-attachment": [], link: [], "cancel-link": [] };
  if (!operation || !Object.hasOwn(allowedOptions, operation)) return { ok: false, error: "Unknown Signal operation" };
  if (Object.keys(options).some(option => !allowedOptions[operation]!.includes(option)) || (attachments.length > 0 && operation !== "send") || (remove && operation !== "react")) return { ok: false, error: "Option does not apply to this operation" };
  const requestId = options["--request-id"];
  if (["send", "react"].includes(operation) && (!requestId || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))) return { ok: false, error: "send/react require --request-id (1..100 letters, digits, - or _)" };
  const done = (value: Invocation): Parsed => ({ ok: true, value: { ...value, ...(requestId ? { requestId } : {}) } });
  if (operation === "list" && args.length === 1) return done({ path: API.messaging.path(), method: "GET" });
  if (!id) return { ok: false, error: "Operation requires an ID; run pi-signal list" };
  if (operation === "open" && args.length === 3 && text) return done({ path: API.messagingOpen.path(), method: "POST", json: { backendId: id, target: text } });
  if (operation === "read" && args.length === 2) {
    for (const key of ["--before", "--limit"]) if (options[key] !== undefined && (!/^\d+$/.test(options[key]!) || !Number.isSafeInteger(Number(options[key])))) return { ok: false, error: `${key} requires a nonnegative integer` };
    if (options["--limit"] !== undefined && (Number(options["--limit"]) < 1 || Number(options["--limit"]) > 100)) return { ok: false, error: "--limit must be 1..100" };
    return done({ path: API.messagingHistory.path({ conversationId: id }, { before: options["--before"], limit: options["--limit"] }), method: "GET" });
  }
  if (operation === "send" && args.length === 3 && text !== undefined) {
    if (!requestId) return { ok: false, error: "send requires --request-id" };
    const input: MessagingSend = { requestId, text: text === "-" ? stdin() : text, attachmentIds: attachments, ...(options["--reply-to"] ? { replyTo: options["--reply-to"] } : {}) };
    return done({ path: API.messagingSend.path({ conversationId: id }), method: "POST", json: { ...input } });
  }
  if (operation === "react" && args.length === 3 && text) {
    const target = parseMessageReference(id);
    if (target && target.transport !== "messaging") return { ok: false, error: "Signal reactions require a Signal message ID" };
    return done({ path: API.messagingReact.path({ messageId: target?.messageId ?? id }), method: "POST", json: { requestId, emoji: text, remove } });
  }
  if (operation === "upload" && args.length === 3 && text) return done({ path: API.messagingUpload.path({ conversationId: id }, { name: basename(text) }), method: "POST", file: text });
  if (operation === "download" && args.length === 2 && options["--output"]) return done({ path: API.messagingAttachment.path({ attachmentId: id }), method: "GET", output: options["--output"] });
  if (operation === "remove-attachment" && args.length === 2) return done({ path: API.messagingRemoveAttachment.path({ attachmentId: id }), method: "DELETE" });
  if (operation === "link" && args.length === 3 && text) return done({ path: API.messagingLink.path({ backendId: id }), method: "POST", json: { deviceName: text } });
  if (operation === "cancel-link" && args.length === 2) return done({ path: API.messagingCancelLink.path({ backendId: id }), method: "DELETE" });
  return { ok: false, error: "Wrong arguments; run pi-signal --help" };
}

export type SignalFetch = (url: URL, init?: RequestInit) => Promise<Response>;
export async function runSignalCli(argv: string[], io = { out: (value: unknown) => console.log(JSON.stringify(value, null, 2)), error: (text: string) => console.error(text), help: (text: string) => console.log(text) }, request: SignalFetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let parsed: Parsed;
  try { parsed = parseSignalArgs(argv); } catch (cause) { io.error(`Cannot read request input: ${String(cause)}`); return 1; }
  if (!parsed.ok) { io.error(parsed.error); return 1; }
  if (!parsed.value) { io.help(SIGNAL_HELP); return 0; }
  const invocation = parsed.value;
  let origin: URL;
  try { origin = new URL(env.PI_REMOTE_SERVER_URL ?? `http://127.0.0.1:${env.PI_REMOTE_ROUTER_PORT ?? "8788"}`); }
  catch { io.error("Invalid local Signal tool origin"); return 1; }
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) { io.error("Signal tool origin must be loopback HTTP without credentials"); return 1; }
  let dispatched = false;
  try {
    const headers = new Headers();
    if (env.PI_REMOTE_SERVER_URL && env.PI_THREAD_TOKEN) headers.set("x-pi-thread-token", env.PI_THREAD_TOKEN);
    let body: BodyInit | undefined;
    if (invocation.json) { headers.set("content-type", "application/json"); body = JSON.stringify(invocation.json); }
    if (invocation.file) {
      const file = Bun.file(invocation.file);
      if (!await file.exists() || file.size > 100 * 1024 * 1024) { io.error("Attachment must exist and be at most 100 MiB"); return 1; }
      headers.set("content-type", file.type || "application/octet-stream"); body = file;
    }
    dispatched = invocation.method !== "GET";
    const response = await request(new URL(invocation.path, origin), { method: invocation.method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(50_000) });
    if (invocation.output && response.ok) {
      await Bun.write(invocation.output, response);
      io.out({ ok: true, path: invocation.output }); return 0;
    }
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Signal tool returned an invalid response");
    io.out({ ...value, ...(invocation.requestId ? { requestId: invocation.requestId } : {}), ...(response.status === 202 ? { accepted: true, guidance: "Durable sending receipt, not delivery. Read history for the outcome; do not send again with a new ID." } : {}) });
    return response.ok ? 0 : 1;
  } catch (cause) {
    io.out({ error: dispatched ? "unconfirmed" : "transport", message: String(cause), ...(invocation.requestId ? { requestId: invocation.requestId } : {}), guidance: dispatched ? "May have executed. Inspect first; reuse the same request ID and payload. Nothing was retried." : "Read failed. Nothing was sent." });
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runSignalCli(process.argv.slice(2));
