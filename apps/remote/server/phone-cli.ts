import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { API } from "./api";
import { personPath, readPerson } from "./persons";
import { PHONE_MAX_FILE_BYTES, phoneCatalogue, phoneCommand, validatePhoneCommand } from "./phone-commands";

export const PHONE_HELP = `usage: pi-phone [--phone DEVICE_ID] [--timeout MS] OPERATION [ARGS]

  list                         Connected and recently disconnected phones
  status                       Phone connection and effective permissions
  catalogue [COMMAND]          Command schemas, grants and result shapes
  command COMMAND [JSON|-]     Any catalogue command; '-' reads JSON from stdin
  tree                         Accessible UI tree
  tap X Y                      Tap screen pixels
  swipe X1 Y1 X2 Y2 [MS]        Swipe (default 300 ms)
  text TEXT [NODE_ID]           Replace focused/node text
  action NODE_ID ACTION        Accessible node action
  global ACTION                back|home|recents|notifications|quickSettings|lock
  screenshot --output PATH     Save PNG bytes to the exact local path
  launch PACKAGE               Launch app
  open URL                     Open Android URL handler
  clipboard TEXT               Set clipboard
  notifications                List notifications
  files list [PHONE_PATH]       List phone directory
  files read PHONE_PATH --output LOCAL_PATH
  files write PHONE_PATH --input LOCAL_PATH [--overwrite --confirm]
  files mkdir PHONE_PATH
  files delete PHONE_PATH --confirm

--phone (alias --device) can appear anywhere. Without it, exactly one online phone is required.
--output PATH also saves any command result carrying base64 binary data.
--confirm supplies confirm:true, never inferred from the command name.
All other operations use 'command NAME JSON'; catalogue gives their arguments.
JSON results go to stdout, failures exit 1. No offline queue or automatic retries.
'unconfirmed' means execution may have happened: inspect state before retrying.

Endpoint: PI_REMOTE_SERVER_URL in a Remote thread, otherwise your Unix person's
registry supervisor port. PI_PHONE_URL explicitly selects another endpoint or
router /v1/remotes/ID prefix. Router requests require PI_REMOTE_SESSION; identity
headers alone never authorize. Local callers use the existing UID-bound transport.
No administrator credential arguments are needed.
`;

type Options = { phone?: string; timeoutMs?: number; output?: string; input?: string; confirm: boolean; overwrite?: boolean };
type Invocation = { kind: "help"; options: Options } | { kind: "list"; options: Options } | { kind: "catalogue"; name?: string; options: Options } | { kind: "command"; command: string; args: Record<string, unknown>; options: Options };
type Parsed = { ok: true; value: Invocation } | { ok: false; message: string };

export function parsePhoneArgs(argv: string[], readStdin: () => string = () => readFileSync(0, "utf8")): Parsed {
  const options: Options = { confirm: false }; const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === "--help" || argument === "-h") return { ok: true, value: { kind: "help", options } };
    if (argument === "--confirm") { options.confirm = true; continue; }
    if (argument === "--overwrite") { options.overwrite = true; continue; }
    if (argument === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const split = argument.indexOf("=");
    const rawKey = split < 0 ? argument.slice(2) : argument.slice(2, split);
    const key = rawKey === "device" ? "phone" : rawKey === "out" ? "output" : rawKey;
    if (!["phone", "timeout", "output", "input"].includes(key)) return { ok: false, message: `Unknown option --${key}` };
    const value = split < 0 ? argv[++i] : argument.slice(split + 1);
    if (!value || value.startsWith("--")) return { ok: false, message: `--${key} needs a value` };
    if (key === "timeout") options.timeoutMs = Number(value);
    else options[key as "phone" | "output" | "input"] = value;
  }
  const [operation, ...values] = positional;
  if (!operation || operation === "help") return { ok: true, value: { kind: "help", options } };
  if (operation === "list") return values.length ? { ok: false, message: "list takes no arguments" } : { ok: true, value: { kind: "list", options } };
  if (operation === "catalogue" || operation === "catalog") return values.length > 1 ? { ok: false, message: "catalogue takes at most one command" } : { ok: true, value: { kind: "catalogue", name: values[0], options } };
  let command: string; let args: Record<string, unknown>;
  const numeric = (index: number) => values[index] === undefined ? undefined : Number(values[index]);
  switch (operation) {
    case "command": {
      if (!values[0] || values.length > 2) return { ok: false, message: "command requires NAME [JSON|-]" };
      command = values[0];
      try { args = JSON.parse(values[1] === "-" ? readStdin() : values[1] ?? "{}"); }
      catch { return { ok: false, message: "Command args must be JSON" }; }
      break;
    }
    case "status": case "tree": case "screenshot": case "notifications":
      if (values.length) return { ok: false, message: `${operation} takes no arguments` };
      command = ({ status: "status", tree: "ui.tree", screenshot: "screen.capture", notifications: "notifications.list" })[operation]!; args = {}; break;
    case "tap": command = "ui.tap"; args = { x: numeric(0), y: numeric(1) }; if (values.length !== 2) return { ok: false, message: "tap requires X Y" }; break;
    case "swipe": command = "ui.swipe"; args = { x1: numeric(0), y1: numeric(1), x2: numeric(2), y2: numeric(3), ...(values[4] === undefined ? {} : { durationMs: numeric(4) }) }; if (values.length < 4 || values.length > 5) return { ok: false, message: "swipe requires X1 Y1 X2 Y2 [MS]" }; break;
    case "text": command = "ui.text"; args = { text: values[0], ...(values[1] === undefined ? {} : { nodeId: values[1] }) }; if (values.length < 1 || values.length > 2) return { ok: false, message: "text requires TEXT [NODE_ID]" }; break;
    case "action": command = "ui.action"; args = { nodeId: values[0], action: values[1] }; if (values.length !== 2) return { ok: false, message: "action requires NODE_ID ACTION" }; break;
    case "global": case "launch": case "open": case "clipboard":
      if (values.length !== 1) return { ok: false, message: `${operation} requires one argument` };
      command = ({ global: "ui.global", launch: "app.launch", open: "url.open", clipboard: "clipboard.set" })[operation]!;
      args = { [({ global: "action", launch: "package", open: "url", clipboard: "text" })[operation]!]: values[0] }; break;
    case "files": {
      const [action, path] = values;
      if (!action || !["list", "read", "write", "mkdir", "delete"].includes(action) || values.length > 2 || (action !== "list" && !path)) return { ok: false, message: "files requires list|read|write|mkdir|delete [PHONE_PATH]" };
      command = `files.${action}`; args = path === undefined ? {} : { path };
      if (action === "read" && !options.output) return { ok: false, message: "files read requires --output LOCAL_PATH" };
      if (action === "write") {
        if (!options.input) return { ok: false, message: "files write requires --input LOCAL_PATH" };
        if (options.overwrite) args.overwrite = true;
        try { const data = readFileSync(options.input); if (data.byteLength > PHONE_MAX_FILE_BYTES) return { ok: false, message: `File exceeds ${PHONE_MAX_FILE_BYTES} bytes` }; args.base64 = data.toString("base64"); }
        catch (cause) { return { ok: false, message: `Cannot read ${options.input}: ${cause instanceof Error ? cause.message : String(cause)}` }; }
      }
      break;
    }
    default: return { ok: false, message: `Unknown operation ${operation}; run pi-phone --help` };
  }
  if (operation === "screenshot" && !options.output) return { ok: false, message: "screenshot requires --output PATH" };
  if (options.confirm) args = { ...args, confirm: true };
  const validated = validatePhoneCommand({ command, args, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  return validated.ok ? { ok: true, value: { kind: "command", command, args, options } } : { ok: false, message: validated.error.message };
}

export function phoneEndpoint(env: NodeJS.ProcessEnv = process.env, user = userInfo().username): { ok: true; url: string; headers: Record<string, string> } | { ok: false; message: string } {
  let endpoint = env.PI_PHONE_URL || env.PI_REMOTE_SERVER_URL;
  if (!endpoint) {
    try { const person = readPerson(personPath(user, env.PI_REMOTE_PERSONS_DIR)); endpoint = `http://127.0.0.1:${person.port}`; }
    catch (cause) { return { ok: false, message: `Cannot find ${user}'s supervisor: ${cause instanceof Error ? cause.message : String(cause)}. Set PI_PHONE_URL to an authorized endpoint.` }; }
  }
  let url: URL;
  try { url = new URL(endpoint); } catch { return { ok: false, message: "Invalid phone endpoint URL" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return { ok: false, message: "Phone endpoint must be HTTP(S), without credentials, query or fragment" };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.PI_REMOTE_SESSION) { headers["x-pi-remote-session"] = env.PI_REMOTE_SESSION; headers["x-pi-remote-user"] = user; }
  else if (env.PI_THREAD_TOKEN) headers["x-pi-thread-token"] = env.PI_THREAD_TOKEN;
  return { ok: true, url: url.href.replace(/\/$/, ""), headers };
}

export function savePhoneBinary(result: unknown, path: string): { ok: true; bytes: number; path: string } | { ok: false; message: string } {
  if (result && typeof result === "object" && "nextOffset" in result && result.nextOffset !== null) return { ok: false, message: "Phone returned a partial file; output was not written. Use command files.read with explicit offset/maxBytes and assemble chunks from JSON base64 results." };
  const base64 = result && typeof result === "object" && "base64" in result ? (result as { base64: unknown }).base64 : undefined;
  if (typeof base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return { ok: false, message: "Phone result does not carry valid base64 binary data" };
  const data = Buffer.from(base64, "base64");
  try { writeFileSync(path, data); return { ok: true, bytes: data.byteLength, path }; }
  catch (cause) { return { ok: false, message: `Cannot save ${path}: ${cause instanceof Error ? cause.message : String(cause)}` }; }
}

export async function runPhoneCli(argv: string[], io = { out: (value: unknown) => console.log(JSON.stringify(value, null, 2)), error: (message: string) => console.error(message), help: (message: string) => console.log(message) }, request: typeof fetch = fetch): Promise<number> {
  const parsed = parsePhoneArgs(argv);
  if (!parsed.ok) { io.error(parsed.message); return 1; }
  const invocation = parsed.value;
  if (invocation.kind === "help") { io.help(PHONE_HELP); return 0; }
  if (invocation.kind === "catalogue") {
    const value = invocation.name ? phoneCommand(invocation.name) : phoneCatalogue();
    if (!value) { io.error(`Unknown command ${invocation.name}`); return 1; }
    io.out(value); return 0;
  }
  const endpoint = phoneEndpoint();
  if (!endpoint.ok) { io.error(endpoint.message); return 1; }
  let dispatched = false;
  try {
    const read = await request(`${endpoint.url}${API.phones.path()}`, { headers: endpoint.headers, signal: AbortSignal.timeout(5_000) });
    const listing = await read.json() as { phones?: Array<{ id: string; connected: boolean }>; error?: unknown };
    if (!read.ok || !Array.isArray(listing.phones)) { io.out(listing); return 1; }
    if (invocation.kind === "list") { io.out(listing); return 0; }
    const online = listing.phones.filter(phone => phone.connected);
    const phone = invocation.options.phone ?? (online.length === 1 ? online[0]!.id : undefined);
    if (!phone) { io.error("Select --phone DEVICE_ID; list must have exactly one online phone for automatic selection"); return 1; }
    const timeoutMs = invocation.options.timeoutMs ?? 15_000;
    dispatched = true;
    const response = await request(`${endpoint.url}${API.phoneCommand.path({ phoneId: phone })}`, { method: "POST", headers: endpoint.headers,
      body: JSON.stringify({ command: invocation.command, args: invocation.args, timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 5_000) });
    const result = await response.json() as { ok?: boolean; result?: unknown };
    if (!response.ok || result.ok !== true) { io.out(result); return 1; }
    if (invocation.options.output) {
      const saved = savePhoneBinary(result.result, invocation.options.output);
      if (!saved.ok) { io.error(saved.message); return 1; }
      io.out({ ...result, result: { path: saved.path, bytes: saved.bytes } });
    } else io.out(result);
    return 0;
  } catch (cause) {
    io.out({ ok: false, error: { code: dispatched ? "unconfirmed" : "transport", message: `${cause instanceof Error ? cause.message : String(cause)}${dispatched ? "; execution may have happened. Nothing was retried." : ""}` } });
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runPhoneCli(process.argv.slice(2));
