export const PHONE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const PHONE_MAX_FILE_BYTES = 1024 * 1024;
export const PHONE_DEFAULT_TIMEOUT_MS = 15_000;
export const PHONE_MAX_TIMEOUT_MS = 60_000;
export const OVERLAY_MAX_SAY = 2000;
export const OVERLAY_MAX_MESSAGE = 8000;

type Field = { type: "string" | "number" | "boolean" | "object" | "array"; required?: boolean; values?: readonly string[]; min?: number; max?: number; description?: string; nullable?: boolean };
export type PhoneCommand = { command: string; description: string; permission?: string; mutation: boolean; args: Record<string, Field>; result?: string };
const str = (required = true, description?: string): Field => ({ type: "string", required, ...(description ? { description } : {}) });
const num = (required = true, min = 0, max?: number): Field => ({ type: "number", required, min, ...(max === undefined ? {} : { max }) });
const choice = (values: readonly string[], required = true): Field => ({ type: "string", required, values });
const paging = { limit: num(false, 1, 500), offset: num(false, 0, 100_000) };
const confirm: Field = { type: "boolean", required: true, description: "Must be true; explicitly authorizes the destructive operation" };
const c = (command: string, description: string, mutation = false, args: Record<string, Field> = {}, permission?: string, result?: string): PhoneCommand => ({ command, description, mutation, args, ...(permission ? { permission } : {}), ...(result ? { result } : {}) });

export const PHONE_COMMANDS: readonly PhoneCommand[] = [
  c("status", "Connection and effective permission state"),
  c("ui.tree", "Read accessible windows and nodes; node IDs are scoped to the current tree", false, {}, "accessibility"),
  c("ui.tap", "Tap screen pixel coordinates", true, { x: num(), y: num() }, "accessibility"),
  c("ui.swipe", "Swipe between screen pixels (default duration 300 ms)", true, { x1: num(), y1: num(), x2: num(), y2: num(), durationMs: num(false, 1, 10_000) }, "accessibility"),
  c("ui.text", "Replace node text, or text in the focused input", true, { text: str(), nodeId: str(false) }, "accessibility"),
  c("ui.action", "Perform an accessible node action", true, { nodeId: str(), action: choice(["click", "longClick", "focus", "scrollForward", "scrollBackward", "paste"]) }, "accessibility"),
  c("ui.global", "Perform an Android global action", true, { action: choice(["back", "home", "recents", "notifications", "quickSettings", "lock"]) }, "accessibility"),
  c("screen.capture", "Capture unprotected screen content; rate limited by Android", false, {}, "screenshots", "{mime:'image/png',base64,width,height}"),
  c("overlay.show", "Show Kenan's overlay dot (persists on the phone)", true, {}, "accessibility", "{visible}"),
  c("overlay.hide", "Hide Kenan's overlay dot (persists on the phone)", true, {}, "accessibility", "{visible}"),
  c("overlay.say", "Speech bubble beside Kenan's dot; x/y or nodeId moves the dot there first. durationMs 0 keeps it until the next say/clear", true, { text: str(), x: num(false), y: num(false), nodeId: str(false), durationMs: num(false, 0, 120_000) }, "accessibility"),
  c("overlay.point", "Fly Kenan's dot to a point, rectangle or tree node and highlight it without acting; optional bubble text", true, { x: num(false), y: num(false), nodeId: str(false), left: num(false), top: num(false), right: num(false), bottom: num(false), text: str(false) }, "accessibility"),
  c("overlay.move", "Fly Kenan's dot to screen pixels", true, { x: num(), y: num() }, "accessibility"),
  c("overlay.state", "Set the dot's animation", true, { state: choice(["idle", "thinking", "working"]) }, "accessibility"),
  c("overlay.clear", "Clear bubble and highlights; the dot glides home", true, {}, "accessibility"),
  c("app.launch", "Launch a visible application", true, { package: str() }),
  c("url.open", "Open a URL using Android's handler", true, { url: str() }),
  c("clipboard.set", "Set clipboard text", true, { text: str() }),
  c("notifications.list", "Read current active notifications", false, {}, "notificationAccess"),
  c("notifications.dismiss", "Dismiss a notification", true, { key: str() }, "notificationAccess"),
  c("notifications.action", "Invoke a notification action", true, { key: str(), actionIndex: num() }, "notificationAccess"),
  c("notifications.reply", "Send a notification's inline reply", true, { key: str(), text: str(), actionIndex: num(false) }, "notificationAccess"),
  c("device.info", "Device, app directories and battery facts"),
  c("apps.list", "List visible apps (Android package visibility applies)", false, { query: str(false), ...paging }, undefined, "{items:[{package,label,version,versionCode,enabled,system}],nextOffset}"),
  c("files.list", "List filesystem directory (default app filesDir); filesystem order", false, { path: str(false), ...paging }, undefined, "{path,items:[{name,path,directory,symlink,size,modified}],nextOffset}"),
  c("files.read", "Read at most 1 MiB; offset/nextOffset support explicit chunk reads", false, { path: str(false), offset: num(false), maxBytes: num(false, 1, PHONE_MAX_FILE_BYTES) }, undefined, "{path,base64,bytes,size,offset,nextOffset:null|number}"),
  c("files.write", "Write at most 1 MiB; default refuses existing files; overwrite requires confirm:true", true, { path: str(), base64: str(), overwrite: { type: "boolean" }, confirm: { ...confirm, required: false } }, undefined, "{path,bytes,written}"),
  c("files.mkdir", "Create directory; parents defaults false", true, { path: str(), parents: { type: "boolean" } }),
  c("files.delete", "Delete file or empty directory; never recursive", true, { path: str(), confirm }),
  c("contacts.list", "List contact names (query optional)", false, { query: str(false), ...paging }, "contacts", "{items:[{_id,display_name,has_phone_number,lookup}],nextOffset}"),
  c("contacts.get", "Read contact Data rows; MIME identifies phone/email/address fields", false, { contactId: num(), ...paging }, "contacts", "{items:[{_id,contact_id,mimetype,data1,data2,data3}],nextOffset}"),
  c("contacts.insert", "Create local contact", true, { name: str(), phone: str(false), email: str(false) }, "contacts"),
  c("calendar.list", "List readable calendars", false, paging, "calendar"),
  c("calendar.events", "Read Events rows; Unix-ms bounds, recurrence is not expanded", false, { calendarId: num(false), start: num(false), end: num(false), ...paging }, "calendar"),
  c("calendar.instances", "Read expanded recurring instances; Unix-ms range at most 366 days", false, { start: num(), end: num(), calendarId: num(false), ...paging }, "calendar", "{items:[{event_id,calendar_id,title,description,eventLocation,begin,end,allDay}],nextOffset}"),
  c("calendar.insert", "Insert calendar event with Unix-ms start/end", true, { calendarId: num(), title: str(), start: num(), end: num(), timezone: str(false), allDay: { type: "boolean" }, description: str(false), location: str(false) }, "calendar"),
  c("location.get", "Read cached or request fresh position; fresh defaults false", false, { provider: str(false), fresh: { type: "boolean" }, maxAgeMs: num(false, 0, 86_400_000), timeoutMs: num(false, 1, 15_000) }, "location", "{latitude,longitude,accuracy,altitude,time,provider,cached}"),
  c("sms.list", "Read SMS rows", false, { address: str(false), ...paging }, "sms"),
  c("sms.send", "Submit SMS (at most 10 segments); not carrier delivery confirmation", true, { to: str(), text: str(), subscriptionId: num(false), confirm }, "sms", "{status:'submitted',segments,delivered:null,note}"),
  c("calls.list", "Read call-log rows", false, { number: str(false), ...paging }, "callLog"),
  c("call.dial", "Request call; Android may restrict background launch; not connected-call confirmation", true, { number: str(), confirm }, "phone"),
  c("usage.query", "Read Android bucket aggregates (default last day, max 366 days)", false, { start: num(false), end: num(false), package: str(false), ...paging }, "usage"),
  c("settings.get", "Read setting (namespace defaults system)", false, { namespace: choice(["system", "secure", "global"], false), key: str() }),
  c("settings.put", "Write setting with actual WRITE_SETTINGS/WRITE_SECURE_SETTINGS grant", true, { namespace: choice(["system", "secure", "global"], false), key: str(), value: { type: "string", required: true, nullable: true }, confirm }),
  c("device.lock", "Request lock using enrolled Device Admin", true, {}, "deviceAdmin"),
  c("device.reboot", "Request reboot; disconnect may precede acknowledgement", true, { confirm }, "deviceOwner"),
  c("device.wipe", "Request factory reset; disconnect may precede acknowledgement", true, { confirm }, "deviceOwner"),
  c("apps.suspend", "Suspend/unsuspend 1..100 packages; inspect failedPackages", true, { packages: { type: "array", required: true }, suspended: { type: "boolean", required: true }, confirm }, "deviceOwner"),
  c("permissions.grant", "Set runtime permission policy; denied/default requires confirm:true", true, { package: str(), permission: str(), state: choice(["granted", "denied", "default"], false), confirm: { ...confirm, required: false } }, "deviceOwner"),
];

export function phoneCommand(name: string): PhoneCommand | undefined { return PHONE_COMMANDS.find(item => item.command === name); }
export function validatePhoneCommand(input: unknown): { ok: true; command: string; args: Record<string, unknown>; timeoutMs: number } | { ok: false; error: { code: string; message: string } } {
  const invalid = (message: string) => ({ ok: false as const, error: { code: "invalid_request", message } });
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("Expected {command,args?,timeoutMs?}");
  const body = input as Record<string, unknown>;
  const command = typeof body.command === "string" ? phoneCommand(body.command) : undefined;
  if (!command) return { ok: false, error: { code: "unsupported", message: "Unknown phone command; read /v1/phones/commands" } };
  const args = body.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return invalid("args must be a JSON object");
  const fields = args as Record<string, unknown>;
  for (const key of Object.keys(fields)) if (!Object.hasOwn(command.args, key)) return invalid(`Unknown ${command.command} argument: ${key}`);
  for (const [key, field] of Object.entries(command.args)) {
    const value = fields[key];
    if (value === undefined && !field.required) continue;
    const matches = value === null && field.nullable ? true : field.type === "array" ? Array.isArray(value) : field.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === field.type;
    if (!matches) return invalid(`${key} must be ${field.type}`);
    if (typeof value === "number" && (!Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) return invalid(`${key} is out of range`);
    if (field.values && !field.values.includes(value as string)) return invalid(`${key} must be one of ${field.values.join(", ")}`);
    if (key === "confirm" && value !== true) return invalid("confirm must be true");
  }
  if ((command.command === "files.write" && fields.overwrite === true || command.command === "permissions.grant" && fields.state !== undefined && fields.state !== "granted") && fields.confirm !== true) return invalid("This operation requires confirm:true");
  if (command.command === "files.write") {
    const data = fields.base64 as string;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || data.length > 4 * Math.ceil(PHONE_MAX_FILE_BYTES / 3) || Buffer.from(data, "base64").byteLength > PHONE_MAX_FILE_BYTES) return invalid("base64 must encode at most 1 MiB");
  }
  if (command.command === "overlay.say" && ((fields.text as string).length < 1 || (fields.text as string).length > OVERLAY_MAX_SAY)) return invalid(`text must be 1..${OVERLAY_MAX_SAY} characters`);
  if (command.command === "overlay.point") {
    const rect = ["left", "top", "right", "bottom"].filter(key => fields[key] !== undefined).length;
    const point = ["x", "y"].filter(key => fields[key] !== undefined).length;
    const targets = (fields.nodeId !== undefined ? 1 : 0) + (point === 2 ? 1 : 0) + (rect === 4 ? 1 : 0);
    if (targets !== 1 || (point % 2) || (rect % 4)) return invalid("point needs exactly one of x+y, left+top+right+bottom, or nodeId");
  }
  if (command.command === "apps.suspend") {
    const packages = fields.packages as unknown[];
    if (packages.length < 1 || packages.length > 100 || packages.some(value => typeof value !== "string" || !value)) return invalid("packages must be 1..100 nonempty strings");
  }
  const timeoutMs = body.timeoutMs ?? PHONE_DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PHONE_MAX_TIMEOUT_MS) return invalid(`timeoutMs must be 1..${PHONE_MAX_TIMEOUT_MS}`);
  return { ok: true, command: command.command, args: fields, timeoutMs };
}

export function phoneCatalogue() {
  return { commands: PHONE_COMMANDS, defaultTimeoutMs: PHONE_DEFAULT_TIMEOUT_MS, maxTimeoutMs: PHONE_MAX_TIMEOUT_MS, maxFileBytes: PHONE_MAX_FILE_BYTES,
    delivery: "Connected phones only. No queue or retries. Unconfirmed means execution may have happened; inspect before deciding whether to retry." };
}

