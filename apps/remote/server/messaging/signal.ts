import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { BackendAttachment, BackendAvatar, BackendCall, BackendCallAudio, BackendConversation, MessagingCallSupport, MessagingPlugin, MessagingPluginContext, MessagingPluginFactory } from "./plugin";
import type { MessagingBackendConfig, MessagingCallState, MessagingCapabilities, MessagingLink, MessagingResult } from "./protocol";
import { qrSvg } from "./qr";
import { openSignalCallAudio } from "./signal-call-audio";

/** signal-cli's own provisioning deadline is shorter than this; it reports the expiry. */
const LINK_SCAN_MS = 10 * 60_000;
const LINK_START_MS = 60_000;
/** How often a connected profile proves its child still answers. */
const PROBE_MS = 60_000;
const PROBE_CEILING_MS = 10_000;
/** Silence for this long earns a rebuilt receive subscription instead of trust. */
const SILENCE_MS = 15 * 60_000;
const positive = (value: unknown, fallback: number): number => typeof value === "number" && value > 0 ? value : fallback;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const failure = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
const success = <T>(value: T): MessagingResult<T> => ({ ok: true, value });
const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);

function executable(command: string): string | null {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(command)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; }
    catch { /* keep looking */ }
  }
  return null;
}

/** Preserve unsigned 64-bit call ids before JavaScript can round them. */
export function parseSignalRpcLine(line: string): ObjectValue {
  const callIdsAsStrings = line.replace(/(?<!\\)("callId"\s*:\s*)(\d+)(?=\s*[,}])/g, "$1\"$2\"");
  return object(JSON.parse(callIdsAsStrings));
}

const rejectionTypes = new Set(["UNREGISTERED_FAILURE", "IDENTITY_FAILURE", "RATE_LIMIT_FAILURE", "INVALID_PRE_KEY_FAILURE"]);
function deliverySummary(results: ObjectValue[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    const type = text(result.type);
    const label = type === "SUCCESS" || type === "NETWORK_FAILURE" || rejectionTypes.has(type) ? type : "UNRECOGNIZED_RESULT";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => `${type}: ${count}`).join(", ");
}

function rpcFailure(error: ObjectValue, sending: boolean): MessagingResult<never> {
  const message = text(error.message) || "Signal request failed";
  if (!sending) return failure(`signal_${error.code ?? "error"}`, message);
  const results = list(object(object(error.data).response).results).map(object);
  const rejected = results.length > 0
    ? results.every(result => rejectionTypes.has(text(result.type)))
    : [-32700, -32600, -32601, -32602, -4, -5, -6].includes(Number(error.code))
      || (error.code === -1 && /^(?:No recipients given|Sending empty message is not allowed|The user .+ is not registered\.)/.test(message));
  return rejected
    ? failure(`signal_${error.code}`, message)
    : failure("unknown", `${message}${results.length ? `; ${deliverySummary(results)}` : ""}; send outcome unknown. Do not retry automatically.`);
}

type Pending = { finish: (result: MessagingResult<unknown>) => void; timer: ReturnType<typeof setTimeout>; send: boolean };

class SignalRpc {
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = "";
  private stderr = "";
  private stderrLine = "";
  private stopped = false;
  private child?: ChildProcessWithoutNullStreams;
  private input?: Writable;
  private exited?: Promise<void>;

  constructor(private notify: (method: string, value: ObjectValue) => void, private failed: (message: string, code: string) => void, private timeout: number, private log: (message: string) => void = () => {}) {}

  async connect(options: { binary: string; dataDir: string; callTunnelBinary: string; callSocketDir: string }): Promise<MessagingResult<void>> {
    try {
      const scratch = join(options.dataDir, "tmp");
      const environment = { ...process.env };
      delete environment.SIGNAL_CLI_CONFIG;
      this.child = spawn(options.binary, ["--data-dir", options.dataDir, "--scrub-log", "jsonRpc", "--receive-mode", "manual"], {
        stdio: "pipe",
        cwd: options.dataDir,
        env: {
          ...environment,
          XDG_CONFIG_HOME: join(options.dataDir, "config"),
          XDG_CACHE_HOME: join(options.dataDir, "cache"),
          TMPDIR: scratch, TMP: scratch, TEMP: scratch,
          JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Djava.io.tmpdir=${JSON.stringify(scratch)}`.trim(),
          SIGNAL_CALL_TUNNEL_BIN: options.callTunnelBinary,
          SIGNAL_CALL_TUNNEL_AUDIO_MODE: "pipe",
          SIGNAL_CALL_TUNNEL_SOCKET_DIR: options.callSocketDir,
        },
      });
      this.input = this.child.stdin;
      this.attach(this.child.stdout);
      this.child.stderr.setEncoding("utf8");
      // signal-cli reports a dropped websocket, a rejected credential and a
      // failing reconnect only on stderr, and `--scrub-log jsonRpc` already
      // keeps message content out of it. Losing that into a 4 KiB ring is what
      // let a two-day receive outage pass unnoticed, so every line is logged
      // and the ring survives only to describe an unexpected exit.
      this.child.stderr.on("data", (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-4096);
        this.stderrLine = (this.stderrLine + chunk).slice(-64 * 1024);
        let newline: number;
        while ((newline = this.stderrLine.indexOf("\n")) >= 0) {
          const line = this.stderrLine.slice(0, newline).trim();
          this.stderrLine = this.stderrLine.slice(newline + 1);
          if (line) this.log(`signal-cli: ${line}`);
        }
      });
      const started = new Promise<MessagingResult<void>>(resolve => {
        this.child!.once("spawn", () => { this.log(`signal-cli started as pid ${this.child?.pid}`); resolve(success(undefined)); });
        this.child!.on("error", error => {
          const result = object(error).code === "ENOENT"
            ? failure("unconfigured", `Signal is unavailable. Install signal-cli with its Java runtime, or set this profile's options.binary to its executable path (${options.binary}).`)
            : failure("connection", detail(error));
          this.abort(result.error.message, result.error.code);
          resolve(result);
        });
        this.child!.once("close", () => resolve(failure("connection", "Signal exited before startup completed")));
      });
      this.child.stdin.on("error", error => this.abort(detail(error)));
      this.exited = new Promise(resolve => this.child!.once("close", (code, signal) => {
        this.log(`signal-cli exited (${signal ?? code})`);
        this.abort(`signal-cli exited (${signal ?? code}): ${this.stderr.trim()}`);
        resolve();
      }));
      return await started;
    } catch (error) {
      return failure("connection", detail(error));
    }
  }

  private attach(output: Readable): void {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      if (this.stopped) return;
      this.buffer += chunk;
      if (this.buffer.length > 128 * 1024 * 1024) {
        this.abort("Signal RPC frame exceeded 128 MiB");
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let frame: ObjectValue;
        try { frame = parseSignalRpcLine(line); }
        catch { this.abort("Invalid JSON from signal-cli"); return; }
        if (frame.method === "receive" || frame.method === "callEvent") this.notify(frame.method, object(frame.params));
        else if (typeof frame.id === "number") {
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          const error = object(frame.error);
          pending.finish(frame.error ? rpcFailure(error, pending.send) : success(frame.result));
        }
      }
    });
    output.on("error", error => this.abort(detail(error)));
    output.on("end", () => this.abort(`Signal RPC output closed: ${this.stderr.trim()}`));
  }

  call(method: string, params: ObjectValue = {}, timeout = this.timeout): Promise<MessagingResult<unknown>> {
    if (this.stopped || !this.input || this.input.destroyed) return Promise.resolve(failure("disconnected", "Signal is not connected"));
    const id = ++this.sequence;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(failure(method === "send" ? "unknown" : "timeout", `Signal ${method} timed out${method === "send" ? "; it may have been delivered. Do not retry automatically." : ""}`));
      }, timeout);
      this.pending.set(id, { finish: resolve, timer, send: method === "send" });
      try {
        this.input!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => {
          if (error) this.abort(detail(error));
        });
      } catch (error) { this.abort(detail(error)); }
    });
  }

  settleSends(): void {
    for (const [id, pending] of this.pending) {
      if (!pending.send) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.finish(failure("unknown", "Signal profile is closing; send outcome unknown. Do not retry automatically."));
    }
  }

  abort(message: string, code = "disconnected"): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.finish(failure(pending.send ? "unknown" : code, pending.send ? `${message}; send outcome unknown. Do not retry automatically.` : message));
    }
    this.pending.clear();
    this.child?.kill("SIGTERM");
    this.failed(message, code);
  }

  async close(): Promise<void> {
    this.abort("Signal connection closed");
    if (this.child && this.exited) {
      const kill = setTimeout(() => this.child?.kill("SIGKILL"), 500);
      await this.exited;
      clearTimeout(kill);
    }
  }
}

export const SIGNAL_ICON = "signal";

interface SignalCallRecord {
  call: BackendCall;
  inputDeviceName: string;
  outputDeviceName: string;
}

function callState(value: string): MessagingCallState | null {
  switch (value) {
    case "RINGING_INCOMING": return "ringing_incoming";
    case "RINGING_OUTGOING": return "ringing_outgoing";
    case "CONNECTING": return "connecting";
    case "CONNECTED": return "connected";
    case "RECONNECTING": return "reconnecting";
    case "ENDED":
    case "IDLE": return "ended";
    default: return null;
  }
}

class SignalPlugin implements MessagingPlugin {
  readonly icon = SIGNAL_ICON;
  readonly capabilities: MessagingCapabilities;
  readonly calls?: MessagingCallSupport;
  readonly linkable = true;
  private link?: MessagingLink;
  private linkRpc?: SignalRpc;
  private linkTask?: Promise<void>;
  private linkCancelled = false;
  private context?: MessagingPluginContext;
  private rpc?: SignalRpc;
  private account = "";
  private ready = false;
  private closing = false;
  private receiveStopped = false;
  private closeTask?: Promise<void>;
  private subscription?: number;
  private callSubscription?: number;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastEvent = 0;
  private rebuilding = false;
  private probeMs = PROBE_MS;
  private probeTimeout = PROBE_CEILING_MS;
  private silenceMs = SILENCE_MS;
  private events: Promise<void> = Promise.resolve();
  private conversations = new Map<string, BackendConversation>();
  private aliases = new Map<string, string>();
  private avatarDir = "";
  private readonly callTunnelCommand: string;
  private readonly callTunnelBinary: string | null;
  private readonly callRecords = new Map<string, SignalCallRecord>();
  private readonly callAudio = new Map<string, BackendCallAudio>();

  constructor(private config: MessagingBackendConfig) {
    this.callTunnelCommand = text(config.options?.callTunnelBinary) || "signal-call-tunnel";
    this.callTunnelBinary = executable(this.callTunnelCommand);
    this.capabilities = { attachments: true, groups: true, calls: this.callTunnelBinary !== null };
    if (this.callTunnelBinary) {
      this.calls = {
        start: peer => this.startCall(peer),
        accept: externalId => this.acceptCall(externalId),
        hangup: externalId => this.hangupCall(externalId),
        audio: externalId => this.openCallAudio(externalId),
      };
    }
  }

  /**
   * signal-cli keeps the pictures it has fetched under `avatars/`, named
   * `profile-<uuid>` or `profile-<number>` for people and `group-<id>` for
   * groups, with no extension. The first present, non-empty file wins.
   */
  private avatar(keys: string[]): BackendAvatar | null {
    if (!this.avatarDir) return null;
    for (const key of keys) {
      if (!key) continue;
      const path = join(this.avatarDir, key);
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.size > 0) return { path, updatedAt: Math.floor(stat.mtimeMs) };
      } catch { /* not this name */ }
    }
    return null;
  }

  private personAvatar(ids: string[]): BackendAvatar | null {
    return this.avatar(ids.filter(id => id && !id.startsWith("u:")).flatMap(id => [`profile-${id}`, `contact-${id}`]));
  }

  async start(context: MessagingPluginContext): Promise<MessagingResult<void>> {
    if (this.rpc) return failure("started", "Signal plugin is already started");
    this.context = context;
    this.closing = false;
    this.receiveStopped = false;
    this.closeTask = undefined;
    const options = this.config.options ?? {};
    if (options.socket !== undefined || options.dataDir !== undefined) return failure("configuration", "Signal state must use this account's encrypted profile directory; external sockets and data directories are not supported");
    const binary = text(options.binary) || "signal-cli";
    const dataDir = join(context.dataDir, "signal-cli");
    this.avatarDir = join(dataDir, "avatars");
    const timeout = positive(options.timeoutMs, 30_000);
    this.probeMs = positive(options.probeMs, PROBE_MS);
    this.silenceMs = positive(options.silenceMs, SILENCE_MS);
    this.probeTimeout = Math.min(timeout, PROBE_CEILING_MS);
    try {
      for (const directory of [context.dataDir, dataDir, join(dataDir, "tmp"), join(dataDir, "config"), join(dataDir, "cache")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
    } catch (error) { return failure("storage", detail(error)); }
    if (this.closing) return failure("closed", "Signal profile closed during startup");
    context.status("connecting", "Connecting to signal-cli");
    this.rpc = new SignalRpc((method, value) => method === "callEvent" ? this.receiveCallEvent(value) : this.enqueue(value), (message, code) => {
      this.ready = false;
      this.stopWatchdog();
      if (!this.closing) context.status(code === "unconfigured" ? "unconfigured" : "error", message);
    }, timeout, message => context.log(message));
    const connected = await this.rpc.connect({ binary, dataDir, callTunnelBinary: this.callTunnelBinary ?? this.callTunnelCommand, callSocketDir: join(dataDir, "tmp") });
    if (!connected.ok) return this.startFailure(connected);
    if (this.closing) return failure("closed", "Signal profile closed during startup");
    const accounts = await this.rpc.call("listAccounts");
    if (!accounts.ok) return this.startFailure(accounts);
    if (this.closing) return failure("closed", "Signal profile closed during startup");
    const numbers = list(accounts.value).map(value => text(object(value).number)).filter(Boolean);
    this.account = text(options.account) || (numbers.length === 1 ? numbers[0]! : "");
    if (!this.account || !numbers.includes(this.account)) {
      // Keep this profile closable: linking from the app starts its own child
      // later, and a memoized close would orphan it at supervisor handoff.
      await this.stopConnection();
      context.status("unconfigured", numbers.length > 1 ? "Set options.account to choose a linked Signal account" : "Signal is not linked yet. Link this profile to your phone to start using it.");
      return success(undefined);
    }
    const directories = await this.refreshDirectories();
    if (!directories.ok) return this.startFailure(directories);
    if (this.closing) return failure("closed", "Signal profile closed during startup");
    const subscribed = await this.rpc.call("subscribeReceive", { account: this.account });
    if (!subscribed.ok) return this.startFailure(subscribed);
    if (this.closing) return failure("closed", "Signal profile closed during startup");
    if (typeof subscribed.value !== "number") return this.startFailure(failure("protocol", "Signal returned an invalid receive subscription"));
    this.subscription = subscribed.value;
    if (this.calls) {
      const callSubscribed = await this.rpc.call("subscribeCallEvents", { account: this.account });
      if (!callSubscribed.ok) return this.startFailure(callSubscribed);
      if (typeof callSubscribed.value !== "number") return this.startFailure(failure("protocol", "Signal returned an invalid call subscription"));
      this.callSubscription = callSubscribed.value;
    }
    this.ready = true;
    this.lastEvent = Date.now();
    this.startWatchdog();
    context.log(`receive subscription ${this.subscription} is live for ${this.account}${this.callSubscription === undefined ? "" : `; call subscription ${this.callSubscription} is live`}`);
    context.status("ready", `Signal linked as ${this.account}. History starts when this plugin receives messages.`);
    return success(undefined);
  }

  /**
   * signal-cli announces neither a wedged child nor a receive subscription that
   * stopped delivering, and a profile that quietly stops receiving looks exactly
   * like a profile nobody messaged. So the adapter checks both itself: the child
   * has to keep answering, and a long quiet stretch gets a rebuilt subscription.
   * A failure here turns into `error`, which the service retries.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => void this.checkLiveness(), this.probeMs);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private async checkLiveness(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || !this.ready || this.closing || this.rebuilding) return;
    const answered = await rpc.call("listAccounts", {}, this.probeTimeout);
    if (!answered.ok) { rpc.abort(`Signal stopped answering its health check: ${answered.error.message}`); return; }
    const quiet = Date.now() - this.lastEvent;
    if (quiet < this.silenceMs || this.closing) return;
    this.rebuilding = true;
    try {
      this.context?.log(`no Signal receive events for ${Math.round(quiet / 60_000)} minutes; rebuilding subscription ${this.subscription}`);
      if (this.subscription !== undefined) await rpc.call("unsubscribeReceive", { account: this.account, subscription: this.subscription }, this.probeTimeout);
      if (this.callSubscription !== undefined) await rpc.call("unsubscribeCallEvents", { account: this.account, subscription: this.callSubscription }, this.probeTimeout);
      const subscribed = await rpc.call("subscribeReceive", { account: this.account }, this.probeTimeout);
      if (!subscribed.ok) { rpc.abort(`Signal receive subscription could not be rebuilt: ${subscribed.error.message}`); return; }
      if (typeof subscribed.value !== "number") { rpc.abort("Signal returned an invalid receive subscription while rebuilding"); return; }
      this.subscription = subscribed.value;
      if (this.calls) {
        const callSubscribed = await rpc.call("subscribeCallEvents", { account: this.account }, this.probeTimeout);
        if (!callSubscribed.ok) { rpc.abort(`Signal call subscription could not be rebuilt: ${callSubscribed.error.message}`); return; }
        if (typeof callSubscribed.value !== "number") { rpc.abort("Signal returned an invalid call subscription while rebuilding"); return; }
        this.callSubscription = callSubscribed.value;
      }
      this.lastEvent = Date.now();
      this.context?.log(`receive subscription rebuilt as ${this.subscription}`);
    } finally { this.rebuilding = false; }
  }

  /**
   * Ask signal-cli for a device-link URI and return once it can be displayed.
   * The wait for the phone to scan it continues in the background: this needs
   * its own child because an unlinked profile has no running connection, and a
   * second process must never share a live profile's data directory.
   */
  async startLink(deviceName: string): Promise<MessagingResult<MessagingLink>> {
    const context = this.context;
    if (!context) return failure("configuration", "This Signal profile has not started yet");
    if (this.closing) return failure("closed", "This Signal profile is stopping. Reload after the supervisor restarts it.");
    if (this.ready) return failure("linked", `This profile is already linked as ${this.account}. Remove it from Signal's linked devices before linking another account.`);
    if (this.link?.status === "waiting") return success(this.link);
    const name = deviceName.trim() || "PiStack";
    const options = this.config.options ?? {};
    const binary = text(options.binary) || "signal-cli";
    const dataDir = join(context.dataDir, "signal-cli");
    try {
      for (const directory of [context.dataDir, dataDir, join(dataDir, "tmp"), join(dataDir, "config"), join(dataDir, "cache")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
    } catch (error) { return failure("storage", detail(error)); }
    this.linkCancelled = false;
    const rpc = new SignalRpc(() => {}, () => {}, LINK_START_MS, message => context.log(message));
    const connected = await rpc.connect({ binary, dataDir, callTunnelBinary: this.callTunnelBinary ?? this.callTunnelCommand, callSocketDir: join(dataDir, "tmp") });
    if (!connected.ok) { await rpc.close(); return connected; }
    const started = await rpc.call("startLink", {}, LINK_START_MS);
    if (!started.ok) { await rpc.close(); return started; }
    const uri = text(object(started.value).deviceLinkUri);
    if (!uri) { await rpc.close(); return failure("protocol", "signal-cli returned no device link URI"); }
    this.linkRpc = rpc;
    this.setLink({ status: "waiting", uri, qr: await qrSvg(uri), deviceName: name, account: null, error: null, updatedAt: Date.now() });
    this.linkTask = this.awaitScan(rpc, uri, name);
    return success(this.link!);
  }

  private async awaitScan(rpc: SignalRpc, uri: string, deviceName: string): Promise<void> {
    const finished = await rpc.call("finishLink", { deviceLinkUri: uri, deviceName }, LINK_SCAN_MS);
    await rpc.close();
    if (this.linkRpc === rpc) this.linkRpc = undefined;
    if (this.linkCancelled) {
      this.setLink({ status: "cancelled", uri: null, qr: null, deviceName, account: null, error: null, updatedAt: Date.now() });
      return;
    }
    if (!finished.ok) {
      this.setLink({ status: "failed", uri: null, qr: null, deviceName, account: null, error: `${finished.error.message}. Start the link again to get a fresh code.`, updatedAt: Date.now() });
      return;
    }
    const account = text(object(finished.value).number);
    this.setLink(account
      ? { status: "linked", uri: null, qr: null, deviceName, account, error: null, updatedAt: Date.now() }
      : { status: "failed", uri: null, qr: null, deviceName, account: null, error: "Signal completed the link without naming the account. Start the link again.", updatedAt: Date.now() });
  }

  async cancelLink(): Promise<MessagingLink> {
    const deviceName = this.link?.deviceName ?? "PiStack";
    const cancelled: MessagingLink = { status: "cancelled", uri: null, qr: null, deviceName, account: null, error: null, updatedAt: Date.now() };
    if (this.link?.status !== "waiting") return this.link ?? cancelled;
    this.linkCancelled = true;
    this.linkRpc?.abort("Device linking was cancelled");
    await this.linkTask;
    return this.link ?? cancelled;
  }

  private setLink(value: MessagingLink): void {
    this.link = value;
    this.context?.link(value);
  }

  private async startFailure(result: { ok: false; error: { code: string; message: string } }): Promise<MessagingResult<void>> {
    await this.close();
    this.context?.status(result.error.code === "unconfigured" ? "unconfigured" : "error", result.error.message);
    return result;
  }

  private remember(conversation: BackendConversation): BackendConversation {
    this.conversations.set(conversation.id, conversation);
    this.context?.conversation(conversation);
    return conversation;
  }

  private contact(value: unknown): void {
    const contact = object(value);
    const number = text(contact.number);
    const uuid = text(contact.uuid);
    const username = text(contact.username);
    const id = uuid || number || (username ? `u:${username}` : "");
    if (!id) return;
    const aliases = [...new Set([id, number, uuid, username ? `u:${username}` : ""].filter(Boolean))];
    for (const alias of aliases) this.aliases.set(alias, id);
    const profile = object(contact.profile);
    const name = text(contact.nickName).trim() || text(contact.name).trim()
      || [text(profile.givenName).trim(), text(profile.familyName).trim()].filter(Boolean).join(" ");
    const avatar = this.personAvatar([uuid, number]);
    this.context!.sender({ id, aliases, name: name || null, avatar });
    if (contact.isBlocked || contact.isHidden || contact.unregistered) return;
    this.remember({ id, title: name || number || id, kind: "direct", avatar });
  }

  private async refreshDirectories(): Promise<MessagingResult<void>> {
    const rpc = this.rpc;
    if (!rpc) return failure("disconnected", "Signal is not connected");
    const contacts = await rpc.call("listContacts", { account: this.account, allRecipients: true });
    if (!contacts.ok) return contacts;
    for (const contact of list(contacts.value)) this.contact(contact);
    const groups = await rpc.call("listGroups", { account: this.account });
    if (!groups.ok) return groups;
    for (const value of list(groups.value)) {
      const group = object(value);
      const id = text(group.id);
      if (id && group.isMember !== false && !group.isBlocked) this.remember({ id: `group:${id}`, title: text(group.name) || id, kind: "group", avatar: this.avatar([`group-${id}`]) });
    }
    return success(undefined);
  }

  async openConversation(target: string): Promise<MessagingResult<BackendConversation>> {
    if (!this.ready) return failure("unconfigured", "Signal is not connected to a linked account");
    target = target.trim();
    const known = this.conversations.get(this.aliases.get(target) ?? target);
    if (known) return success(known);
    if (target.startsWith("group:")) return failure("recipient", "Choose a known Signal group. Group creation and joining are not supported here.");
    if (!/^(?:\+[1-9]\d{6,14}|(?:PNI:)?[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|u:\S+)$/i.test(target)) return failure("recipient", "Enter an international phone number, Signal UUID, or u:username.000");
    const contacts = await this.rpc!.call("listContacts", { account: this.account, recipient: [target] });
    if (!contacts.ok) return contacts;
    for (const contact of list(contacts.value)) this.contact(contact);
    const id = this.aliases.get(target) ?? target;
    return success(this.conversations.get(id) ?? this.remember({ id, title: target, kind: "direct" }));
  }

  private parseCall(value: unknown, fallback?: { peer?: string; direction?: "incoming" | "outgoing" }): MessagingResult<BackendCall> {
    const raw = object(value);
    const externalId = text(raw.callId);
    const previous = this.callRecords.get(externalId);
    const state = callState(text(raw.state));
    const peer = text(raw.uuid) || text(raw.number) || fallback?.peer || previous?.call.peer || "";
    const direction = typeof raw.isOutgoing === "boolean"
      ? (raw.isOutgoing ? "outgoing" : "incoming")
      : fallback?.direction ?? previous?.call.direction;
    if (!externalId || !state || !peer || !direction) return failure("protocol", "Signal returned an invalid call state");
    const call: BackendCall = { externalId, peer, direction, state, reason: text(raw.reason) || null };
    this.callRecords.set(externalId, {
      call,
      inputDeviceName: text(raw.inputDeviceName) || previous?.inputDeviceName || "",
      outputDeviceName: text(raw.outputDeviceName) || previous?.outputDeviceName || "",
    });
    return success(call);
  }

  private receiveCallEvent(notification: ObjectValue): void {
    this.lastEvent = Date.now();
    const value = "result" in notification ? object(notification.result) : notification;
    if ((notification.account && notification.account !== this.account) || (value.account && value.account !== this.account)) return;
    const call = this.parseCall(value);
    if (!call.ok) {
      this.context?.status("error", call.error.message);
      return;
    }
    this.context?.call(call.value);
    if (call.value.state === "ended") this.callRecords.delete(call.value.externalId);
  }

  private async startCall(peer: string): Promise<MessagingResult<BackendCall>> {
    const rpc = this.rpc;
    if (!this.ready || !rpc || !this.calls) return failure("unconfigured", "Signal calling is unavailable");
    const result = await rpc.call("startCall", { account: this.account, recipient: peer });
    return result.ok ? this.parseCall(result.value, { peer, direction: "outgoing" }) : result;
  }

  private async acceptCall(externalId: string): Promise<MessagingResult<BackendCall>> {
    const rpc = this.rpc;
    const previous = this.callRecords.get(externalId);
    if (!this.ready || !rpc || !this.calls) return failure("unconfigured", "Signal calling is unavailable");
    if (!previous) return failure("call_not_found", "Signal no longer has this call");
    const result = await rpc.call("acceptCall", { account: this.account, callId: externalId });
    return result.ok ? this.parseCall(result.value, { peer: previous.call.peer, direction: previous.call.direction }) : result;
  }

  private async hangupCall(externalId: string): Promise<MessagingResult<void>> {
    const rpc = this.rpc;
    if (!this.ready || !rpc || !this.calls) return failure("unconfigured", "Signal calling is unavailable");
    const method = this.callRecords.get(externalId)?.call.state === "ringing_incoming" ? "rejectCall" : "hangupCall";
    const result = await rpc.call(method, { account: this.account, callId: externalId });
    return result.ok ? success(undefined) : result;
  }

  private async openCallAudio(externalId: string): Promise<MessagingResult<BackendCallAudio>> {
    const existing = this.callAudio.get(externalId);
    if (existing) return success(existing);
    const record = this.callRecords.get(externalId);
    if (!record?.inputDeviceName || !record.outputDeviceName) return failure("call_audio", "Signal has not provided the call audio socket yet");
    const opened = await openSignalCallAudio(record.inputDeviceName, record.outputDeviceName, message => {
      if (!this.closing) this.context?.status("error", message);
    });
    if (!opened.ok) return opened;
    const transport = opened.value;
    const managed: BackendCallAudio = {
      onRemote: handler => transport.onRemote(handler),
      write: frame => transport.write(frame),
      close: async () => {
        if (this.callAudio.get(externalId) === managed) this.callAudio.delete(externalId);
        await transport.close();
      },
    };
    this.callAudio.set(externalId, managed);
    return success(managed);
  }

  async send(conversation: BackendConversation, message: { requestId: string; text: string; attachments: BackendAttachment[] }): Promise<MessagingResult<{ externalId: string; timestamp: number }>> {
    const rpc = this.rpc;
    if (!this.ready || !rpc) return failure("unconfigured", "Signal is not connected to a linked account");
    const attachments: string[] = [];
    try {
      for (const attachment of message.attachments) {
        const bytes = await readFile(attachment.path);
        attachments.push(`data:${attachment.mimeType};filename=${encodeURIComponent(attachment.name)};base64,${bytes.toString("base64")}`);
      }
    } catch (error) { return failure("attachment", detail(error)); }
    if (this.closing) return failure("closed", "Signal profile closed before sending");
    const result = await rpc.call("send", {
      account: this.account,
      ...(conversation.kind === "group" ? { groupId: conversation.id.replace(/^group:/, "") } : { recipient: [conversation.id] }),
      message: message.text,
      attachments,
    });
    if (!result.ok) return result;
    const value = object(result.value);
    const timestamp = value.timestamp;
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) return failure("unknown", "Signal send returned no valid timestamp; do not retry automatically");
    const results = list(value.results).map(object);
    if (results.some(item => item.type !== "SUCCESS")) {
      const summary = deliverySummary(results);
      if (!results.every(item => rejectionTypes.has(text(item.type)))) return failure("unknown", `Signal reported incomplete delivery (${summary}); some recipients may have received the message. Do not retry automatically.`);
      return failure("delivery", `Signal rejected delivery: ${summary}`);
    }
    return success({ externalId: this.sentId(timestamp), timestamp });
  }

  private sentId(timestamp: number): string { return `${this.account}:sent:${timestamp}`; }

  private enqueue(value: ObjectValue): void {
    this.lastEvent = Date.now();
    if (this.receiveStopped) return;
    this.events = this.events.then(() => this.receive(value)).catch(error => {
      this.rpc?.abort(`Signal message persistence failed: ${detail(error)}`);
    });
  }

  private async receive(notification: ObjectValue): Promise<void> {
    const value = "result" in notification ? object(notification.result) : notification;
    if (value.account && value.account !== this.account) return;
    const envelope = object(value.envelope);
    const sender = text(envelope.sourceUuid) || text(envelope.sourceNumber) || text(envelope.source);
    const senderName = text(envelope.sourceName).trim();
    if (sender && senderName) {
      const aliases = [...new Set([sender, text(envelope.sourceNumber), text(envelope.source)].filter(Boolean))];
      this.context!.sender({ id: this.aliases.get(sender) ?? sender, aliases, name: senderName, avatar: this.personAvatar([text(envelope.sourceUuid), text(envelope.sourceNumber)]) });
    }
    const sync = object(envelope.syncMessage);
    if (sync.contacts || sync.groups) {
      const result = await this.refreshDirectories();
      if (!result.ok) { this.context?.status("error", result.error.message); return; }
    }
    const outgoing = !!sync.sentMessage;
    const data = object(outgoing ? sync.sentMessage : envelope.dataMessage);
    if (!Object.keys(data).length) return;
    if (data.viewOnce || (typeof data.expiresInSeconds === "number" && data.expiresInSeconds > 0)) {
      this.context?.status("ready", "A disappearing or view-once Signal message was omitted. This messaging store does not support expiring content.");
      return;
    }
    const body = text(data.message);
    const attached = list(data.attachments);
    if (!body && !attached.length) return;
    const timestamp = data.timestamp ?? envelope.timestamp;
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) { this.context?.status("error", "Signal message has no valid timestamp"); return; }
    const destination = outgoing ? text(data.destinationUuid) || text(data.destinationNumber) || text(data.destination) : sender;
    const group = object(data.groupInfo);
    const groupId = text(group.groupId);
    const id = groupId ? `group:${groupId}` : this.aliases.get(destination) ?? destination;
    if (!id) { this.context?.status("error", "Signal message has no conversation address"); return; }
    const conversation = this.conversations.get(id) ?? this.remember({ id, title: text(group.name) || (!outgoing ? text(envelope.sourceName) : "") || destination || id, kind: groupId ? "group" : "direct" });
    const attachments: BackendAttachment[] = [];
    const stage = attached.length ? await mkdtemp(join(this.context!.dataDir, "incoming-")) : undefined;
    try {
      for (let index = 0; index < attached.length; index++) {
        const attachment = object(attached[index]);
        const attachmentId = text(attachment.id);
        const response = await this.rpc!.call("getAttachment", { account: this.account, id: attachmentId, ...(groupId ? { groupId } : { recipient: destination }) });
        if (!response.ok) { this.context?.status("error", response.error.message); return; }
        const encoded = object(response.value).data;
        if (typeof encoded !== "string") { this.context?.status("error", "Signal attachment response has no data"); return; }
        const bytes = Buffer.from(encoded, "base64");
        const path = join(stage!, String(index));
        await writeFile(path, bytes, { mode: 0o600 });
        attachments.push({ path, name: text(attachment.filename) || attachmentId, mimeType: text(attachment.contentType) || "application/octet-stream", size: bytes.length });
      }
      await this.context!.message({
        id: outgoing ? this.sentId(timestamp) : `${this.account}:${sender}:${timestamp}`,
        conversation, direction: outgoing ? "outgoing" : "incoming", sender: outgoing ? this.account : sender,
        text: body, timestamp, attachments,
      });
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
    }
  }

  close(): Promise<void> {
    return this.closeTask ??= this.stop();
  }

  private async stopConnection(): Promise<void> {
    const rpc = this.rpc;
    this.ready = false;
    this.stopWatchdog();
    this.rpc = undefined;
    this.subscription = undefined;
    this.callSubscription = undefined;
    await rpc?.close();
  }

  private async stop(): Promise<void> {
    this.closing = true;
    this.ready = false;
    this.stopWatchdog();
    if (this.link?.status === "waiting") this.linkCancelled = true;
    this.linkRpc?.abort("Signal profile is closing");
    await this.linkTask;
    const rpc = this.rpc;
    rpc?.settleSends();
    if (rpc && this.subscription !== undefined) {
      const stopped = await rpc.call("unsubscribeReceive", { account: this.account, subscription: this.subscription }, 1000);
      if (!stopped.ok) rpc.abort(`Unable to stop Signal receive: ${stopped.error.message}`);
    }
    if (rpc && this.callSubscription !== undefined) {
      const stopped = await rpc.call("unsubscribeCallEvents", { account: this.account, subscription: this.callSubscription }, 1000);
      if (!stopped.ok) rpc.abort(`Unable to stop Signal call events: ${stopped.error.message}`);
    }
    this.receiveStopped = true;
    await this.events;
    await Promise.allSettled([...this.callAudio.values()].map(audio => audio.close()));
    this.callAudio.clear();
    this.callRecords.clear();
    await rpc?.close();
    this.subscription = undefined;
    this.callSubscription = undefined;
    this.rpc = undefined;
  }
}

export const createMessagingPlugin: MessagingPluginFactory = config => new SignalPlugin(config);
