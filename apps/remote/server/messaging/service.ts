import { Database } from "bun:sqlite";
import { ActionJournal, actionPerson, journalWarning, type ActionTicket } from "kenan-memory/journal";
import { openActionStore, canonicalRecipient, type ActionStore, type ActionRecord, type ActionSubmission, type ActionTicket as DispatchTicket } from "kenan-memory/actions";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { API } from "../api";
import { isReactionEmoji, messageReference, parseMessageReference, type MessageReaction, type MessageReply } from "../message-protocol";
import { API_CORS_HEADERS } from "../cors";
import { inlineSafe, servedFileResponse } from "../files";
import { storeUpload, uploadName } from "../uploads";
import type { BackendAttachment, BackendConversation, BackendMessage, BackendReaction, BackendReply, BackendSender, MessagingPlugin, MessagingPluginFactory } from "./plugin";
import type { MessagingAttachment, MessagingBackendConfig, MessagingBackendInfo, MessagingConversation, MessagingHistory, MessagingHistoryChanges, MessagingLink, MessagingMessage, MessagingResult, MessagingSend, MessagingSnapshot, MessagingPurpose } from "./protocol";

const DEVICE_NAME = /^[\p{L}\p{N} .,'()_-]{1,64}$/u;

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const failureText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" } });
class MessagingFailure extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string, readonly action?: ActionRecord) { super(message); }
}
interface ConversationRow { id: string; backend_id: string; external_id: string; title: string; kind: "direct" | "group"; updated_at: number; unread: number; current: number; revision: number }

/*
 * Every change to what a client renders for a message gives that message a new
 * revision from one counter, and raises its conversation's revision. Clients
 * hold a conversation revision and fetch only messages revised after it.
 * Triggers own this so no write path can forget: rendered messages join
 * attachments, reactions, quotes, sender names, aliases, avatars and the account.
 * `SET revision=revision` touches a row; message_touched turns that into a new revision.
 */
const touchIdentity = (backend: string, identity: string, extra = "") => {
  const ids = `(SELECT ${identity} UNION SELECT alias FROM messaging_sender_aliases WHERE backend_id=${backend} AND sender_id=${identity})`;
  return `UPDATE messages SET revision=revision WHERE conversation_id IN (SELECT id FROM conversations WHERE backend_id=${backend}) AND (
    sender IN ${ids} OR quote_author IN ${ids}${extra}
    OR timestamp IN (SELECT target_timestamp FROM messaging_reactions WHERE backend_id=${backend} AND (sender IN ${ids} OR account IN ${ids} OR target_author IN ${ids})));`;
};
const REVISION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS message_removals(conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,revision INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS message_removal_revision ON message_removals(conversation_id,revision);
  CREATE INDEX IF NOT EXISTS message_revision ON messages(conversation_id,revision);
  CREATE TRIGGER IF NOT EXISTS message_revised AFTER UPDATE OF revision ON messages BEGIN
    UPDATE conversations SET revision=MAX(revision,NEW.revision) WHERE id=NEW.conversation_id;
  END;
  CREATE TRIGGER IF NOT EXISTS message_touched AFTER UPDATE ON messages WHEN NEW.revision IS OLD.revision BEGIN
    UPDATE messaging_state SET revision=revision+1;
    UPDATE messages SET revision=(SELECT revision FROM messaging_state) WHERE seq=NEW.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS message_quotable_changed AFTER UPDATE OF timestamp,status ON messages BEGIN
    UPDATE messages SET revision=revision WHERE conversation_id=NEW.conversation_id AND quote_timestamp IN (OLD.timestamp,NEW.timestamp) AND seq<>NEW.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS message_added AFTER INSERT ON messages BEGIN
    UPDATE messaging_state SET revision=revision+1;
    UPDATE messages SET revision=(SELECT revision FROM messaging_state) WHERE seq=NEW.seq;
    UPDATE messages SET revision=revision WHERE conversation_id=NEW.conversation_id AND quote_timestamp=NEW.timestamp AND seq<>NEW.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS message_removed AFTER DELETE ON messages BEGIN
    UPDATE messaging_state SET revision=revision+1;
    INSERT INTO message_removals VALUES(OLD.conversation_id,OLD.id,OLD.seq,(SELECT revision FROM messaging_state));
    UPDATE conversations SET revision=MAX(revision,(SELECT revision FROM messaging_state)) WHERE id=OLD.conversation_id;
    UPDATE messages SET revision=revision WHERE conversation_id=OLD.conversation_id AND quote_timestamp=OLD.timestamp;
  END;
  CREATE TRIGGER IF NOT EXISTS message_attachment_added AFTER INSERT ON message_attachments BEGIN
    UPDATE messages SET revision=revision WHERE id=NEW.message_id;
  END;
  CREATE TRIGGER IF NOT EXISTS message_attachment_removed AFTER DELETE ON message_attachments BEGIN
    UPDATE messages SET revision=revision WHERE id=OLD.message_id;
  END;
  ${["INSERT", "UPDATE"].map(event => `CREATE TRIGGER IF NOT EXISTS message_reaction_${event.toLowerCase()} AFTER ${event} ON messaging_reactions BEGIN
    UPDATE messages SET revision=revision WHERE timestamp=NEW.target_timestamp
      AND conversation_id IN (SELECT id FROM conversations WHERE backend_id=NEW.backend_id AND external_id=NEW.conversation_external_id);
  END;
  CREATE TRIGGER IF NOT EXISTS message_sender_${event.toLowerCase()} AFTER ${event} ON messaging_senders BEGIN
    ${touchIdentity("NEW.backend_id", "NEW.id")}
  END;
  CREATE TRIGGER IF NOT EXISTS message_alias_${event.toLowerCase()} AFTER ${event} ON messaging_sender_aliases BEGIN
    ${touchIdentity("NEW.backend_id", "NEW.sender_id", " OR sender=NEW.alias OR quote_author=NEW.alias")}
  END;
  CREATE TRIGGER IF NOT EXISTS message_account_${event.toLowerCase()} AFTER ${event} ON messaging_accounts BEGIN
    ${touchIdentity("NEW.backend_id", "NEW.sender_id", " OR direction='outgoing'")}
  END;`).join("\n")}
  ${["INSERT", "UPDATE", "DELETE"].map(event => { const row = event === "DELETE" ? "OLD" : "NEW"; return `CREATE TRIGGER IF NOT EXISTS message_avatar_${event.toLowerCase()} AFTER ${event} ON messaging_avatars BEGIN
    ${touchIdentity(`${row}.backend_id`, `${row}.id`)}
  END;`; }).join("\n")}
`;
interface ReactionRow { target_timestamp: number; target_author: string; sender: string; account: string; emoji: string; removed: number; event_timestamp: number }
interface MessageRow { seq: number; id: string; conversation_id: string; external_id: string | null; direction: "incoming" | "outgoing"; sender: string; text: string; timestamp: number; status: MessagingMessage["status"]; error: string | null; request_body: string | null; quote_author: string | null; quote_timestamp: number | null; quote_text: string | null; quote_message_id: string | null }
interface AttachmentRow { id: string; conversation_id: string; message_id: string | null; name: string; mime_type: string; size: number; path: string }
interface Backend { config: MessagingBackendConfig; info: MessagingBackendInfo; plugin?: MessagingPlugin; attempts: number; retry?: ReturnType<typeof setTimeout> }
type ReactionReceipt = MessagingResult<MessageReaction[]>;
interface ReactionRequestRow { request_body: string; receipt: string | null }
export type MessagingActionStore = Pick<ActionStore, "submit" | "followup" | "claim" | "dispatch" | "finish" | "inspect" | "holdRecipient" | "linkRecipients" | "close">;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validPurpose = (value: MessagingPurpose): boolean =>
  (value.intentKey === undefined || typeof value.intentKey === "string" && !!value.intentKey.trim() && value.intentKey.length <= 1000)
  && (value.followup === undefined || !!value.followup && typeof value.followup.actionId === "string" && ID.test(value.followup.actionId)
    && Number.isSafeInteger(value.followup.revision) && value.followup.revision > 0 && typeof value.followup.evidence === "string"
    && !!value.followup.evidence.trim() && value.followup.evidence.length <= 1000);

/**
 * A backend that fails to start used to stay dead until the next supervisor
 * handoff, with its only complaint sitting in an in-memory snapshot. That is
 * how a Signal profile stopped receiving for two days without a single line
 * anywhere. Failures are now retried on their own, with a ceiling, and every
 * transition is written where `journalctl` can find it.
 */
export interface MessagingRetry { baseMs: number; maxMs: number; unconfiguredMs: number }
export const MESSAGING_RETRY: MessagingRetry = {
  baseMs: 5_000,
  maxMs: 5 * 60_000,
  /** An unlinked profile is a normal resting state, so it only re-checks slowly. */
  unconfiguredMs: 30 * 60_000,
};

export function messagingConfig(raw: string | undefined): MessagingBackendConfig[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("PI_REMOTE_MESSAGING_BACKENDS must be an array");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !ID.test(entry.id)
      || entry.plugin !== "signal" || typeof entry.label !== "string" || !entry.label.trim()
      || (entry.options !== undefined && (!entry.options || typeof entry.options !== "object" || Array.isArray(entry.options)))) {
      throw new Error("Signal profiles require id, plugin signal, label and optional options object");
    }
    if (seen.has(entry.id)) throw new Error(`Duplicate messaging backend ${entry.id}`);
    seen.add(entry.id);
    return entry as MessagingBackendConfig;
  });
}

async function loadPlugin(config: MessagingBackendConfig): Promise<MessagingPlugin> {
  if (config.plugin !== "signal") throw new Error("Only Signal profiles are supported");
  const module = await import("./signal");
  if (typeof module.createMessagingPlugin !== "function") throw new Error("Messaging plugin must export createMessagingPlugin");
  return (module.createMessagingPlugin as MessagingPluginFactory)(config);
}

export class MessagingService {
  private readonly db: Database;
  private readonly journal: Pick<ActionJournal, "begin" | "finish">;
  private readonly actions: MessagingActionStore;
  private readonly ownsActions: boolean;
  private readonly backends = new Map<string, Backend>();
  private readonly sends = new Map<string, Promise<MessagingMessage>>();
  private readonly receives = new Set<Promise<void>>();
  private readonly requests = new Set<Promise<unknown>>();
  private readonly reactionRequests = new Map<string, Promise<ReactionReceipt>>();
  private closing = false;
  private closed = false;
  private started: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  constructor(readonly root: string, configs: MessagingBackendConfig[], private readonly factory = loadPlugin, private readonly onChange: () => void = () => {}, private readonly retry: MessagingRetry = MESSAGING_RETRY, journal?: Pick<ActionJournal, "begin" | "finish">, actions?: MessagingActionStore) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.actions = actions ?? openActionStore();
    this.ownsActions = actions === undefined;
    this.journal = journal ?? new ActionJournal({ enabled: () => true, directory: join(root, "action-journal"), person: actionPerson() });
    this.db = new Database(join(root, "messages.sqlite3"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,backend_id TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,updated_at INTEGER NOT NULL,unread INTEGER NOT NULL DEFAULT 0,UNIQUE(backend_id,external_id));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),external_id TEXT,direction TEXT NOT NULL,sender TEXT NOT NULL,text TEXT NOT NULL,timestamp INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,request_body TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS message_external ON messages(conversation_id,external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS message_history ON messages(conversation_id,seq);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),message_id TEXT REFERENCES messages(id),name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachment_message ON attachments(message_id);
      CREATE TABLE IF NOT EXISTS message_attachments(message_id TEXT NOT NULL REFERENCES messages(id),attachment_id TEXT NOT NULL REFERENCES attachments(id),PRIMARY KEY(message_id,attachment_id));
      CREATE TABLE IF NOT EXISTS messaging_senders(backend_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT,PRIMARY KEY(backend_id,id));
      CREATE TABLE IF NOT EXISTS messaging_accounts(backend_id TEXT PRIMARY KEY,sender_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messaging_sender_aliases(backend_id TEXT NOT NULL,alias TEXT NOT NULL,sender_id TEXT NOT NULL,PRIMARY KEY(backend_id,alias),FOREIGN KEY(backend_id,sender_id) REFERENCES messaging_senders(backend_id,id));
      CREATE TABLE IF NOT EXISTS messaging_reactions(backend_id TEXT NOT NULL,conversation_external_id TEXT NOT NULL,target_author TEXT NOT NULL,target_timestamp INTEGER NOT NULL,sender TEXT NOT NULL,account TEXT NOT NULL,emoji TEXT NOT NULL,removed INTEGER NOT NULL,event_timestamp INTEGER NOT NULL,PRIMARY KEY(backend_id,conversation_external_id,target_author,target_timestamp,sender));
      CREATE INDEX IF NOT EXISTS messaging_reaction_target ON messaging_reactions(backend_id,conversation_external_id,target_timestamp);
      CREATE TABLE IF NOT EXISTS messaging_reaction_requests(request_id TEXT PRIMARY KEY,request_body TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS messaging_state(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messaging_avatars(backend_id TEXT NOT NULL,id TEXT NOT NULL,path TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(backend_id,id));
      INSERT OR IGNORE INTO messaging_state(id,version) VALUES(1,1);`);
    this.db.transaction(() => {
      const columns = this.db.query("PRAGMA table_info(conversations)").all() as { name: string }[];
      if (!columns.some(column => column.name === "current")) {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN current INTEGER NOT NULL DEFAULT 0;
          UPDATE conversations SET current=1 WHERE EXISTS(SELECT 1 FROM messages WHERE conversation_id=conversations.id);`);
      }
      const messageColumns = this.db.query("PRAGMA table_info(messages)").all() as { name: string }[];
      if (!messageColumns.some(column => column.name === "quote_author")) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN quote_author TEXT;
          ALTER TABLE messages ADD COLUMN quote_timestamp INTEGER;
          ALTER TABLE messages ADD COLUMN quote_text TEXT;
          ALTER TABLE messages ADD COLUMN quote_message_id TEXT;`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS message_quote_target ON messages(conversation_id,timestamp)");
      if (!messageColumns.some(column => column.name === "revision")) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE messaging_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
          UPDATE messages SET revision=seq;
          UPDATE conversations SET revision=COALESCE((SELECT MAX(revision) FROM messages WHERE conversation_id=conversations.id),0);
          UPDATE messaging_state SET revision=COALESCE((SELECT MAX(seq) FROM messages),0);`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS messaging_action_requests(request_id TEXT PRIMARY KEY,action_id TEXT NOT NULL,ticket TEXT,kind TEXT NOT NULL CHECK(kind IN ('message','reaction')));
        CREATE INDEX IF NOT EXISTS messaging_action_id ON messaging_action_requests(action_id);
        CREATE TABLE IF NOT EXISTS messaging_action_refusals(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('message','reaction')),receipt TEXT NOT NULL);`);
      this.db.exec(REVISION_SCHEMA);
      this.db.query("UPDATE messaging_reaction_requests SET receipt=? WHERE receipt IS NULL").run(JSON.stringify({ ok: false, error: { code: "unknown", message: "Supervisor stopped before the backend confirmed this reaction. Check the recipient before reacting again." } }));
      this.db.exec(`UPDATE messages SET status='unknown',error='Supervisor stopped before the backend confirmed this send. Check the recipient before sending again.' WHERE status='sending';
        UPDATE conversations SET updated_at=COALESCE((SELECT MAX(timestamp) FROM messages WHERE conversation_id=conversations.id),0);
        UPDATE messaging_state SET version=version+1;`);
    })();
    for (const sender of this.db.query("SELECT backend_id,id FROM messaging_senders").all() as { backend_id: string; id: string }[]) this.linkSenderAliases(sender.backend_id, sender.id);
    this.adoptOutboundRequests();
    for (const config of configs) this.backends.set(config.id, { config, attempts: 0, info: { id: config.id, plugin: config.plugin, icon: "", label: config.label, status: "connecting", detail: "Starting messaging backend", capabilities: { attachments: false, groups: false }, linkable: false, link: null } });
  }
  start(): Promise<void> {
    return this.started ??= Promise.all([...this.backends.values()].map(backend => this.launch(backend))).then(() => {});
  }
  private async launch(backend: Backend): Promise<void> {
    try {
      const dataDir = join(this.root, "backends", backend.config.id);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const suffix = relative(realpathSync(this.root), realpathSync(dataDir));
      if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../")) throw new Error("Messaging account profile must remain inside its encrypted folder");
      backend.plugin = await this.factory(backend.config);
      if (typeof backend.plugin.icon !== "string" || !ID.test(backend.plugin.icon)) throw new Error("Messaging plugin must declare an icon asset name");
      backend.info.capabilities = { ...backend.plugin.capabilities };
      backend.info.icon = backend.plugin.icon;
      backend.info.linkable = Boolean(backend.plugin.linkable && backend.plugin.startLink);
      this.changed();
      if (this.closing) return;
      const result = await backend.plugin.start({
        dataDir,
        conversation: value => { if (!this.closed) this.upsertConversation(backend.config.id, value); },
        sender: value => { if (!this.closed) this.upsertSender(backend.config.id, value); },
        self: id => {
          if (this.closed || !id) return;
          if (this.db.query(`INSERT INTO messaging_accounts(backend_id,sender_id) VALUES(?,?)
            ON CONFLICT(backend_id) DO UPDATE SET sender_id=excluded.sender_id WHERE sender_id<>excluded.sender_id`).run(backend.config.id, id).changes) this.changed();
        },
        message: value => {
          if (this.closed) return Promise.reject(new Error("Messaging is closed"));
          const task = this.receive(backend.config.id, value);
          this.receives.add(task);
          void task.then(() => this.receives.delete(task), () => this.receives.delete(task));
          return task;
        },
        reaction: value => {
          if (this.closed) return Promise.reject(new Error("Messaging is closed"));
          const task = this.receiveReaction(backend.config.id, value);
          this.receives.add(task);
          void task.finally(() => this.receives.delete(task)).catch(() => {});
          return task;
        },
        status: (status, detail) => this.setStatus(backend, status, detail),
        log: message => this.log(backend, message),
        link: value => this.setLink(backend, value),
      });
      if (!result.ok) this.setStatus(backend, result.error.code === "unconfigured" ? "unconfigured" : "error", result.error.message);
    } catch (cause) { this.setStatus(backend, "error", failureText(cause)); }
  }
  /**
   * Device linking. The plugin owns the exchange with its service; this owns
   * the state clients see and the restart that turns a freshly linked account
   * into a working connection.
   */
  async startLink(backendId: string, deviceName: string): Promise<MessagingLink> {
    const backend = this.backends.get(backendId);
    if (!backend) throw new MessagingFailure("Messaging backend not configured", 404);
    if (!backend.plugin?.startLink || !backend.info.linkable) throw new MessagingFailure("This messaging backend cannot link an account from the app", 409);
    if (backend.info.status === "ready") throw new MessagingFailure("This messaging account is already linked", 409);
    const name = deviceName.trim() || "PiStack";
    if (!DEVICE_NAME.test(name)) throw new MessagingFailure("Device name must be 1 to 64 ordinary characters");
    const result = await backend.plugin.startLink(name);
    if (!result.ok) throw new MessagingFailure(result.error.message, result.error.code === "closed" ? 503 : 400);
    this.setLink(backend, result.value);
    return result.value;
  }
  async cancelLink(backendId: string): Promise<MessagingLink> {
    const backend = this.backends.get(backendId);
    if (!backend) throw new MessagingFailure("Messaging backend not configured", 404);
    if (!backend.plugin?.cancelLink) throw new MessagingFailure("This messaging backend cannot link an account from the app", 409);
    const link = await backend.plugin.cancelLink();
    this.setLink(backend, link);
    return link;
  }
  private setLink(backend: Backend, link: MessagingLink): void {
    if (link.status !== "waiting" && link.status !== "linked" && link.status !== "failed" && link.status !== "cancelled") throw new MessagingFailure("Unsupported messaging link status", 502, "protocol");
    if (this.closed) return;
    backend.info.link = link;
    this.changed();
    if (link.status === "linked") this.track(this.relaunch(backend, `Connecting ${link.account ?? "the linked account"}`));
  }
  /** A linked account needs a fresh connection; the old plugin has no account. */
  private async relaunch(backend: Backend, connecting: string): Promise<void> {
    if (this.closing || this.closed) return;
    try { await backend.plugin?.close(); }
    catch (cause) { this.setStatus(backend, "error", `The previous messaging connection did not stop: ${failureText(cause)}`); return; }
    if (this.closing || this.closed) return;
    backend.plugin = undefined;
    this.setStatus(backend, "connecting", connecting);
    await this.launch(backend);
  }
  private log(backend: Backend, message: string): void {
    console.log(`[messaging ${backend.config.id}] ${message}`);
  }
  /**
   * Bring a failed backend back without waiting for a human or a handoff.
   * Repeated failures back off to `RETRY_MAX_MS`; a profile with no account
   * waits `UNCONFIGURED_RETRY_MS`, which also picks up an account linked
   * outside the app.
   */
  private scheduleRelaunch(backend: Backend): void {
    if (this.closing || this.closed || backend.retry) return;
    const unconfigured = backend.info.status === "unconfigured";
    backend.attempts = unconfigured ? 0 : backend.attempts + 1;
    const delay = unconfigured ? this.retry.unconfiguredMs : Math.min(this.retry.baseMs * 2 ** (backend.attempts - 1), this.retry.maxMs);
    this.log(backend, `reconnecting in ${Math.round(delay / 1000)}s`);
    backend.retry = setTimeout(() => {
      backend.retry = undefined;
      if (this.closing || this.closed) return;
      this.track(this.relaunch(backend, "Reconnecting after a failed messaging backend"));
    }, delay);
    backend.retry.unref?.();
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.requests.add(task);
    void task.then(() => this.requests.delete(task), () => this.requests.delete(task));
    return task;
  }
  private changed(): void {
    this.db.exec("UPDATE messaging_state SET version=version+1 WHERE id=1");
    this.onChange();
  }
  private setStatus(backend: Backend, status: MessagingBackendInfo["status"], detail: string): void {
    if (status !== "ready" && status !== "unconfigured" && status !== "connecting" && status !== "error") throw new MessagingFailure("Unsupported messaging backend status", 502, "protocol");
    if (this.closed || (backend.info.status === status && backend.info.detail === detail)) return;
    backend.info.status = status;
    backend.info.detail = detail;
    this.log(backend, `${status}: ${detail}`);
    this.changed();
    if (status === "ready") {
      backend.attempts = 0;
      if (backend.retry) { clearTimeout(backend.retry); backend.retry = undefined; }
      return;
    }
    if (status === "error" || status === "unconfigured") this.scheduleRelaunch(backend);
  }
  snapshot(): MessagingSnapshot {
    const { version } = this.db.query("SELECT version FROM messaging_state WHERE id=1").get() as { version: number };
    return {
      version,
      backends: [...this.backends.values()].map(backend => ({ ...backend.info, capabilities: { ...backend.info.capabilities }, link: backend.info.link && { ...backend.info.link } })),
      conversations: (this.db.query("SELECT * FROM conversations ORDER BY updated_at DESC,id").all() as ConversationRow[]).map(row => this.conversation(row)),
    };
  }
  private conversation(row: ConversationRow): MessagingConversation {
    return { id: row.id, backendId: row.backend_id, externalId: row.external_id, title: row.title, kind: row.kind, updatedAt: row.updated_at, revision: row.revision };
  }
  private conversationRow(id: string): ConversationRow {
    const row = this.db.query("SELECT * FROM conversations WHERE id=?").get(id) as ConversationRow | null;
    if (!row) throw new MessagingFailure("Messaging conversation not found", 404);
    return row;
  }
  private upsertConversation(backendId: string, value: BackendConversation): ConversationRow {
    if (!value.id || !value.title || !["direct", "group"].includes(value.kind)) throw new Error("Backend returned an invalid conversation");
    const result = this.db.query(`INSERT INTO conversations(id,backend_id,external_id,title,kind,updated_at) VALUES(?,?,?,?,?,0)
      ON CONFLICT(backend_id,external_id) DO UPDATE SET title=excluded.title,kind=excluded.kind
      WHERE conversations.title<>excluded.title OR conversations.kind<>excluded.kind`).run(crypto.randomUUID(), backendId, value.id, value.title, value.kind);
    if (result.changes) this.changed();
    return this.db.query("SELECT * FROM conversations WHERE backend_id=? AND external_id=?").get(backendId, value.id) as ConversationRow;
  }
  private upsertSender(backendId: string, value: BackendSender): void {
    if (!value.id || (value.name !== null && !value.name.trim()) || value.aliases.some(alias => !alias)) throw new Error("Backend returned an invalid sender");
    const changed = this.db.transaction(() => {
      let changes = this.db.query(`INSERT INTO messaging_senders(backend_id,id,name) VALUES(?,?,?)
        ON CONFLICT(backend_id,id) DO UPDATE SET name=excluded.name WHERE messaging_senders.name IS NOT excluded.name`).run(backendId, value.id, value.name).changes;
      for (const alias of new Set([value.id, ...value.aliases])) {
        changes += this.db.query(`INSERT INTO messaging_sender_aliases(backend_id,alias,sender_id) VALUES(?,?,?)
          ON CONFLICT(backend_id,alias) DO UPDATE SET sender_id=excluded.sender_id WHERE messaging_sender_aliases.sender_id<>excluded.sender_id`).run(backendId, alias, value.id).changes;
      }
      if (changes > 0) this.linkSenderAliases(backendId, value.id);
      return changes > 0;
    })();
    if (changed) this.changed();
  }
  private linkSenderAliases(backendId: string, senderId: string): void {
    const aliases = this.db.query("SELECT alias FROM messaging_sender_aliases WHERE backend_id=? AND sender_id=?").all(backendId, senderId) as { alias: string }[];
    const identities = [...new Set([senderId, ...aliases.map(item => item.alias)].map(id => canonicalRecipient(id).startsWith("tel:") ? canonicalRecipient(id) : `signal:${id}`))];
    if (identities.length < 2) return;
    const linked = this.actions.linkRecipients(identities, "messaging-provider-directory");
    if (!linked.ok) throw new MessagingFailure(linked.message, 503, `action_${linked.error}`);
  }
  private adoptOutboundRequests(): void {
    const pending: Array<Parameters<MessagingService["adoptRequest"]>> = [];
    const rows = this.db.query(`SELECT m.* FROM messages m LEFT JOIN messaging_action_requests r ON r.request_id=m.id
      WHERE m.request_body IS NOT NULL AND r.request_id IS NULL AND NOT EXISTS(SELECT 1 FROM messaging_action_refusals f WHERE f.request_id=m.id) ORDER BY m.seq DESC`).all() as MessageRow[];
    for (const row of rows) {
      const conversation = this.conversationRow(row.conversation_id);
      const input = JSON.parse(row.request_body!) as MessagingSend;
      const attachments = input.attachmentIds.map(id => this.db.query("SELECT * FROM attachments WHERE id=?").get(id) as AttachmentRow | null);
      const reply = row.quote_author !== null && row.quote_timestamp !== null && row.quote_text !== null
        ? { author: row.quote_author, timestamp: row.quote_timestamp, text: row.quote_text } : undefined;
      const payload = attachments.every((item): item is AttachmentRow => item !== null && existsSync(item.path))
        ? this.effectPayload(conversation, row.text, attachments, reply)
        : { operation: "message", target: this.actionRecipient(conversation), text: row.text, attachments: { state: "historical-content-unavailable", count: attachments.length }, reply: reply ?? null };
      pending.push([conversation, row.id, "message", input.intentKey ?? `signal.message:${digest(payload)}`, payload,
        row.status === "sent" ? "succeeded" : row.status === "failed" ? "failed-before-effect" : "uncertain",
        row.external_id ?? row.error ?? "Historical send outcome unknown"]);
    }
    const reactions = this.db.query(`SELECT m.* FROM messaging_reaction_requests m LEFT JOIN messaging_action_requests r ON r.request_id=m.request_id
      WHERE r.request_id IS NULL AND NOT EXISTS(SELECT 1 FROM messaging_action_refusals f WHERE f.request_id=m.request_id) ORDER BY m.rowid DESC`).all() as (ReactionRequestRow & { request_id: string })[];
    for (const request of reactions) {
      const input = JSON.parse(request.request_body) as { messageId: string; emoji: string; remove: boolean; intentKey?: string };
      const row = this.db.query("SELECT * FROM messages WHERE id=?").get(input.messageId) as MessageRow | null;
      if (!row) throw new Error("Historical reaction request lost its target; cannot safely initialize messaging authority");
      const conversation = this.conversationRow(row.conversation_id);
      const payload = { operation: "reaction", target: this.actionRecipient(conversation), author: this.messageSender(row, conversation.backend_id), timestamp: row.timestamp, emoji: input.emoji, remove: input.remove };
      const receipt = request.receipt ? JSON.parse(request.receipt) as ReactionReceipt : null;
      pending.push([conversation, request.request_id, "reaction", input.intentKey ?? `signal.reaction:${digest(payload)}`, payload,
        receipt?.ok ? "succeeded" : receipt && !receipt.ok && receipt.error.code !== "unknown" ? "failed-before-effect" : "uncertain",
        receipt?.ok ? "Historical confirmed reaction receipt" : receipt && !receipt.ok ? receipt.error.message : "Historical reaction outcome unknown"]);
    }
    const priority = { uncertain: 0, succeeded: 1, "failed-before-effect": 2 };
    pending.sort((a, b) => priority[a[5]] - priority[b[5]]);
    for (const request of pending) this.adoptRequest(...request);
  }
  private adoptRequest(conversation: ConversationRow, requestId: string, kind: "message" | "reaction", intentKey: string, payload: unknown, state: "succeeded" | "failed-before-effect" | "uncertain", detail: string): void {
    const result = this.reserveResult(conversation, requestId, intentKey, payload);
    if (!result.ok) {
      if ((result.error !== "fenced" && result.error !== "payload-conflict") || !result.action) throw new Error(result.message);
      if (state === "uncertain") {
        for (const recipient of this.actionRecipients(conversation)) {
          const hold = this.actions.holdRecipient(recipient, `Historical unknown Signal request ${requestId} must be reconciled before further contact`, "messaging-migration");
          if (!hold.ok) throw new Error(hold.message);
        }
      }
      this.db.query("INSERT INTO messaging_action_refusals VALUES(?,?,?)").run(requestId, kind, JSON.stringify(result));
      return;
    }
    const reservation = result.value;
    if (reservation.disposition === "created" && reservation.action.state === "accepted") {
      const claim = this.actions.claim(reservation.action.id, "messaging-migration");
      if (!claim.ok) throw new Error(claim.message);
      const finished = this.actions.finish(claim.value, state, null, { kind: state === "succeeded" ? "provider-receipt" : state === "failed-before-effect" ? "provider-rejection" : "operator-observation", reference: `historical-signal:${requestId}`, detail: detail.slice(0, 1000) || "Historical native receipt" });
      if (!finished.ok) throw new Error(finished.message);
    }
    this.db.query("INSERT INTO messaging_action_requests VALUES(?,?,NULL,?)").run(requestId, reservation.action.id, kind);
  }
  private effectPayload(conversation: ConversationRow, text: string, attachments: AttachmentRow[], reply?: BackendReply) {
    return { operation: "message", target: this.actionRecipient(conversation), text,
      attachments: attachments.map(item => ({ name: item.name, mimeType: item.mime_type, size: item.size, sha256: createHash("sha256").update(readFileSync(item.path)).digest("hex") })),
      reply: reply ? { ...reply, author: this.canonical(conversation.backend_id, reply.author) } : null };
  }
  private actionRecipient(conversation: ConversationRow): string {
    if (conversation.kind === "group") return `signal:${conversation.external_id}`;
    const sender = this.canonical(conversation.backend_id, conversation.external_id);
    const aliases = this.db.query("SELECT alias FROM messaging_sender_aliases WHERE backend_id=? AND sender_id=? ORDER BY alias").all(conversation.backend_id, sender) as { alias: string }[];
    const identities = [conversation.external_id, sender, ...aliases.map(item => item.alias)].map(canonicalRecipient);
    return identities.find(id => id.startsWith("tel:")) ?? `signal:${sender}`;
  }
  private actionRecipients(conversation: ConversationRow): string[] {
    if (conversation.kind === "group") return [this.actionRecipient(conversation)];
    const sender = this.canonical(conversation.backend_id, conversation.external_id);
    const aliases = this.db.query("SELECT alias FROM messaging_sender_aliases WHERE backend_id=? AND sender_id=?").all(conversation.backend_id, sender) as { alias: string }[];
    return [...new Set([conversation.external_id, sender, ...aliases.map(item => item.alias)].map(id => canonicalRecipient(id).startsWith("tel:") ? canonicalRecipient(id) : `signal:${id}`))];
  }
  private reserveResult(conversation: ConversationRow, requestId: string, intentKey: string, payload: unknown, followup?: MessagingPurpose["followup"], authenticatedThreadId: string | null = null) {
    const input = { intentKey, recipients: this.actionRecipients(conversation), transport: "signal", payload, requestId: `signal:${requestId}`, threadId: authenticatedThreadId ?? "messaging-owner", authenticatedThreadId };
    return followup ? this.actions.followup(followup.actionId, followup.revision, input, { kind: "operator-observation", reference: `signal:${requestId}`, detail: followup.evidence }) : this.actions.submit(input);
  }
  private reserve(conversation: ConversationRow, requestId: string, intentKey: string, payload: unknown, followup?: MessagingPurpose["followup"], authenticatedThreadId: string | null = null) {
    const result = this.reserveResult(conversation, requestId, intentKey, payload, followup, authenticatedThreadId);
    if (!result.ok) throw new MessagingFailure(result.message, result.error === "unavailable" ? 503 : 409, `action_${result.error}`, result.action);
    return result.value;
  }
  private projectMessageAction(row: MessageRow, action: ActionRecord): MessagingMessage {
    const saved = action.result as MessagingResult<{ externalId: string; timestamp: number }> | null;
    if (action.state === "succeeded" && saved?.ok && typeof saved.value?.externalId === "string" && Number.isSafeInteger(saved.value.timestamp)
      && (row.status !== "sent" || row.external_id !== saved.value.externalId)) {
      this.db.query("UPDATE messages SET external_id=?,timestamp=?,status='sent',error=NULL WHERE id=?").run(saved.value.externalId, saved.value.timestamp, row.id);
      this.changed();
      Object.assign(row, { external_id: saved.value.externalId, timestamp: saved.value.timestamp, status: "sent", error: null });
    }
    return this.message(row);
  }
  private finishAction(ticket: DispatchTicket, result: MessagingResult<unknown>): string | null {
    const outcome = result.ok ? "succeeded" : result.error.code === "unknown" ? "uncertain" : "failed-before-effect";
    const finished = this.actions.finish(ticket, outcome, result, {
      kind: result.ok ? "provider-receipt" : result.error.code === "unknown" ? "operator-observation" : "provider-rejection",
      reference: ticket.id, detail: result.ok ? "Signal provider accepted the effect" : result.error.message.slice(0, 1000) || "Provider rejected the effect",
    });
    return finished.ok ? null : `Action receipt unavailable: ${finished.message}. Do not resend; action remains fenced.`;
  }
  private readyBackend(id: string): Backend & { plugin: MessagingPlugin } {
    const backend = this.backends.get(id);
    if (!backend) throw new MessagingFailure("Messaging backend not configured", 404);
    if (!backend.plugin || backend.info.status !== "ready") throw new MessagingFailure(backend.info.detail || "Messaging backend is not ready", 503);
    return backend as Backend & { plugin: MessagingPlugin };
  }
  async open(backendId: string, target: string): Promise<MessagingConversation> {
    if (!target.trim() || target.length > 500) throw new MessagingFailure("Recipient is required");
    const existing = this.db.query("SELECT * FROM conversations WHERE backend_id=? AND external_id=?").get(backendId, target.trim()) as ConversationRow | null;
    if (existing) return this.conversation(existing);
    const backend = this.readyBackend(backendId);
    const result = await backend.plugin.openConversation(target.trim());
    if (!result.ok) throw new MessagingFailure(result.error.message);
    return this.conversation(this.upsertConversation(backendId, result.value));
  }
  private attachment(row: AttachmentRow): MessagingAttachment {
    return { id: row.id, name: row.name, mimeType: row.mime_type, size: row.size };
  }
  private canonical(backendId: string, id: string): string {
    const alias = this.db.query("SELECT sender_id FROM messaging_sender_aliases WHERE backend_id=? AND alias=?").get(backendId, id) as { sender_id: string } | null;
    return alias?.sender_id ?? id;
  }
  private reactions(row: MessageRow, loaded?: { conversation: ConversationRow; events: ReactionRow[]; canonical: (id: string) => string; names: Map<string, string | null> }): MessageReaction[] {
    const conversation = loaded?.conversation ?? this.conversationRow(row.conversation_id);
    const events = loaded?.events ?? this.db.query(`SELECT * FROM messaging_reactions WHERE backend_id=? AND conversation_external_id=? AND target_timestamp=? ORDER BY event_timestamp DESC,rowid DESC`)
      .all(conversation.backend_id, conversation.external_id, row.timestamp) as ReactionRow[];
    const canonical = loaded?.canonical ?? ((id: string) => this.canonical(conversation.backend_id, id));
    const reactions = new Map<string, MessageReaction>();
    const seen = new Set<string>();
    for (const event of events) {
      const account = canonical(event.account);
      const target = canonical(event.target_author);
      if (row.direction === "outgoing" ? target !== account : target !== canonical(row.sender)) continue;
      const sender = canonical(event.sender);
      if (seen.has(sender)) continue;
      seen.add(sender);
      if (event.removed) continue;
      const name = loaded ? loaded.names.get(sender) : (this.db.query("SELECT name FROM messaging_senders WHERE backend_id=? AND id=?").get(conversation.backend_id, sender) as { name: string | null } | null)?.name;
      reactions.set(sender, { emoji: event.emoji, sender: { id: sender, ...(name ? { name } : {}) }, timestamp: event.event_timestamp, own: sender === account });
    }
    return [...reactions.values()].sort((a, b) => a.timestamp - b.timestamp || a.sender.id.localeCompare(b.sender.id));
  }
  private async receiveReaction(backendId: string, value: BackendReaction): Promise<void> {
    if (!value.target.author || !value.account || !value.sender || !Number.isSafeInteger(value.target.timestamp)
      || !Number.isSafeInteger(value.timestamp) || !value.emoji || value.emoji.length > 64) throw new Error("Backend returned an invalid reaction");
    this.upsertConversation(backendId, value.conversation);
    const changed = this.db.query(`INSERT INTO messaging_reactions(backend_id,conversation_external_id,target_author,target_timestamp,sender,account,emoji,removed,event_timestamp)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(backend_id,conversation_external_id,target_author,target_timestamp,sender)
      DO UPDATE SET account=excluded.account,emoji=excluded.emoji,removed=excluded.removed,event_timestamp=excluded.event_timestamp
      WHERE excluded.event_timestamp>messaging_reactions.event_timestamp`)
      .run(backendId, value.conversation.id, value.target.author, value.target.timestamp, value.sender, value.account, value.emoji, Number(value.remove), value.timestamp).changes;
    if (changed) this.changed();
  }
  /** The id is the local messaging message id, not the Signal timestamp or universal reference. */
  react(messageId: string, emoji: string, remove: boolean, requestId: string, intentKey?: string, followup?: MessagingPurpose["followup"], authenticatedThreadId: string | null = null): Promise<ReactionReceipt> {
    const error = (code: string, message: string): Promise<ReactionReceipt> => Promise.resolve({ ok: false, error: { code, message } });
    if (this.closing || this.closed) return error("closed", "Messaging is handing over");
    if (typeof requestId !== "string" || !ID.test(requestId) || typeof messageId !== "string" || !messageId || typeof emoji !== "string" || !isReactionEmoji(emoji) || typeof remove !== "boolean" || !validPurpose({ intentKey, followup }))
      return error("invalid_reaction", "A valid requestId, message id, single emoji and remove boolean are required");
    const body = JSON.stringify({ messageId, emoji, remove, ...(intentKey !== undefined ? { intentKey } : {}), ...(followup !== undefined ? { followup } : {}) });
    const existing = this.db.query("SELECT request_body,receipt FROM messaging_reaction_requests WHERE request_id=?").get(requestId) as ReactionRequestRow | null;
    if (existing) {
      if (existing.request_body !== body) return error("request_conflict", "This requestId belongs to a different reaction");
      if (existing.receipt !== null) {
        const projection = this.db.query("SELECT action_id FROM messaging_action_requests WHERE request_id=?").get(requestId) as { action_id: string } | null;
        const action = projection ? this.actions.inspect(projection.action_id) : null;
        return action?.ok ? this.restoreReaction(requestId, messageId, emoji, remove, action.value, existing.receipt) : Promise.resolve(JSON.parse(existing.receipt) as ReactionReceipt);
      }
      const admitted = this.reactionRequests.get(requestId);
      if (!admitted) throw new Error("An admitted reaction has no settlement task");
      return admitted;
    }
    const row = this.db.query("SELECT * FROM messages WHERE id=?").get(messageId) as MessageRow | null;
    if (!row || !row.external_id || row.status !== "received" && row.status !== "sent") return error("message_not_found", "No confirmed messaging message with that id");
    const conversation = this.conversationRow(row.conversation_id);
    const backend = this.backends.get(conversation.backend_id);
    if (!backend?.plugin?.react) return error("reactions_unsupported", "This messaging backend does not support reactions");
    if (backend.info.status !== "ready") return error("backend_unavailable", backend.info.detail);
    const payload = { operation: "reaction", target: this.actionRecipient(conversation), author: this.messageSender(row, conversation.backend_id), timestamp: row.timestamp, emoji, remove };
    let reservation: ActionSubmission;
    try { reservation = this.reserve(conversation, requestId, intentKey ?? `signal.reaction:${digest(payload)}`, payload, followup, authenticatedThreadId); }
    catch (cause) { return error(cause instanceof MessagingFailure ? cause.code ?? "action_unavailable" : "action_unavailable", failureText(cause)); }
    if (reservation.disposition !== "created" || reservation.action.state !== "accepted") {
      const prior = this.db.query("SELECT m.request_id,receipt FROM messaging_reaction_requests m JOIN messaging_action_requests r ON r.request_id=m.request_id WHERE r.action_id=? AND r.kind='reaction' LIMIT 1").get(reservation.action.id) as { request_id: string; receipt: string | null } | null;
      if (reservation.disposition === "existing" && prior) {
        if (prior.receipt) return this.restoreReaction(prior.request_id, messageId, emoji, remove, reservation.action, prior.receipt);
        const task = this.reactionRequests.get(prior.request_id);
        if (task) return task;
      }
      if (reservation.disposition !== "existing" || reservation.action.state !== "accepted") return error("action_fenced", `Action ${reservation.action.id} is ${reservation.action.state}; inspect and reconcile, do not retry.`);
    }
    this.db.transaction(() => {
      this.db.query("INSERT INTO messaging_reaction_requests(request_id,request_body) VALUES(?,?)").run(requestId, body);
      this.db.query("INSERT INTO messaging_action_requests VALUES(?,?,NULL,'reaction')").run(requestId, reservation.action.id);
    })();
    const task = Promise.resolve().then(() => this.dispatchReaction(backend.plugin!, conversation, row, emoji, remove, requestId, reservation.action.id)).catch(cause => ({ ok: false as const, error: { code: "unknown", message: `Reaction outcome unknown: ${failureText(cause)}` } })).then(receipt => {
      this.db.query("UPDATE messaging_reaction_requests SET receipt=? WHERE request_id=?").run(JSON.stringify(receipt), requestId);
      return receipt;
    });
    this.reactionRequests.set(requestId, task);
    void task.then(() => this.reactionRequests.delete(requestId), () => this.reactionRequests.delete(requestId));
    return this.track(task);
  }
  private async restoreReaction(requestId: string, messageId: string, emoji: string, remove: boolean, action: ActionRecord, receipt: string): Promise<ReactionReceipt> {
    const previous = JSON.parse(receipt) as ReactionReceipt;
    const saved = action.result as MessagingResult<{ timestamp: number; sender: string }> | null;
    if (previous.ok || action.state !== "succeeded" || !saved?.ok || !Number.isSafeInteger(saved.value?.timestamp) || typeof saved.value?.sender !== "string") return previous;
    const row = this.db.query("SELECT * FROM messages WHERE id=?").get(messageId) as MessageRow | null;
    if (!row) return { ok: false, error: { code: "message_not_found", message: "Confirmed action exists but its native reaction target is unavailable" } };
    const conversation = this.conversationRow(row.conversation_id);
    await this.receiveReaction(conversation.backend_id, { conversation: { id: conversation.external_id, title: conversation.title, kind: conversation.kind }, target: { author: row.direction === "outgoing" ? saved.value.sender : row.sender, timestamp: row.timestamp }, account: saved.value.sender, sender: saved.value.sender, emoji, remove, timestamp: saved.value.timestamp });
    const restored: ReactionReceipt = { ok: true, value: this.reactions(row) };
    this.db.query("UPDATE messaging_reaction_requests SET receipt=? WHERE request_id=?").run(JSON.stringify(restored), requestId);
    return restored;
  }
  private async dispatchReaction(plugin: MessagingPlugin, conversation: ConversationRow, row: MessageRow, emoji: string, remove: boolean, requestId: string, actionId: string): Promise<ReactionReceipt> {
    const claim = this.actions.claim(actionId, "messaging-owner");
    if (!claim.ok) return { ok: false, error: { code: `action_${claim.error}`, message: claim.message } };
    this.db.query("UPDATE messaging_action_requests SET ticket=? WHERE request_id=?").run(JSON.stringify(claim.value), requestId);
    let ticket: ActionTicket | null;
    try { ticket = this.journal.begin({ action: `${conversation.backend_id}.reaction`, recipients: [conversation.title, conversation.external_id], summary: `${remove ? "Removed" : "Sent"} reaction ${emoji}`, externalId: requestId }); }
    catch (cause) {
      this.actions.finish(claim.value, "failed-before-effect", null, { kind: "provider-rejection", reference: "dispatch-not-started", detail: `Local journal rejected before provider invocation: ${failureText(cause)}` });
      return { ok: false, error: { code: "journal_unavailable", message: `Not dispatched: ${failureText(cause)}` } };
    }
    let result;
    const dispatch = this.actions.dispatch(claim.value);
    if (!dispatch.ok) return { ok: false, error: { code: `action_${dispatch.error}`, message: dispatch.message } };
    try { result = await plugin.react!({ id: conversation.external_id, title: conversation.title, kind: conversation.kind }, { author: this.messageSender(row, conversation.backend_id), timestamp: row.timestamp }, emoji, remove); }
    catch (cause) { result = { ok: false as const, error: { code: "unknown", message: `Reaction outcome unknown: ${failureText(cause)}` } }; }
    const authorityWarning = this.finishAction(claim.value, result);
    const journalResult = journalWarning(this.journal.finish(ticket, result.ok ? "confirmed" : result.error.code === "unknown" ? "unconfirmed" : "failed", result.ok ? `Reaction accepted at ${result.value.timestamp}` : result.error.message));
    const warning = authorityWarning ?? journalResult;
    if (warning) { this.db.query("UPDATE messages SET error=? WHERE id=?").run(warning, row.id); this.changed(); }
    if (!result.ok) return result;
    await this.receiveReaction(conversation.backend_id, { conversation: { id: conversation.external_id, title: conversation.title, kind: conversation.kind }, target: { author: row.direction === "outgoing" ? result.value.sender : row.sender, timestamp: row.timestamp }, account: result.value.sender, sender: result.value.sender, emoji, remove, timestamp: result.value.timestamp });
    return { ok: true, value: this.reactions(row), ...(warning ? { journalWarning: warning } : {}) };
  }
  private messageSender(row: MessageRow, backendId: string): string {
    if (row.direction === "outgoing" && row.sender === "You") {
      const account = this.db.query("SELECT sender_id FROM messaging_accounts WHERE backend_id=?").get(backendId) as { sender_id: string } | null;
      return account?.sender_id ?? row.sender;
    }
    return this.canonical(backendId, row.sender);
  }
  private reply(row: MessageRow): MessageReply | undefined {
    if (row.quote_author === null || row.quote_timestamp === null || row.quote_text === null) return undefined;
    const conversation = this.conversationRow(row.conversation_id);
    const author = this.canonical(conversation.backend_id, row.quote_author);
    const target = (this.db.query("SELECT * FROM messages WHERE id=? AND conversation_id=? AND status IN ('received','sent')").get(row.quote_message_id, row.conversation_id) as MessageRow | null)
      ?? (this.db.query("SELECT * FROM messages WHERE conversation_id=? AND timestamp=? AND status IN ('received','sent')").all(row.conversation_id, row.quote_timestamp) as MessageRow[])
        .find(candidate => this.messageSender(candidate, conversation.backend_id) === author);
    const sender = this.db.query("SELECT name FROM messaging_senders WHERE backend_id=? AND id=?").get(conversation.backend_id, author) as { name: string | null } | null;
    const account = this.db.query("SELECT sender_id FROM messaging_accounts WHERE backend_id=?").get(conversation.backend_id) as { sender_id: string } | null;
    const own = !!account && this.canonical(conversation.backend_id, account.sender_id) === author;
    return { messageId: target ? messageReference({ transport: "messaging", messageId: target.id }) : null,
      sender: { id: author, ...(sender?.name ? { name: sender.name } : {}), ...(own ? { own } : {}) }, text: row.quote_text, timestamp: row.quote_timestamp };
  }
  private message(row: MessageRow, prepared?: { attachments: MessagingAttachment[]; sender: { name: string | null } | null; account: string | null; reactions: MessageReaction[] }): MessagingMessage {
    const attachments = prepared?.attachments ?? (this.db.query("SELECT a.* FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id WHERE ma.message_id=? ORDER BY a.rowid").all(row.id) as AttachmentRow[]).map(item => this.attachment(item));
    if (row.request_body) {
      const order = (JSON.parse(row.request_body) as MessagingSend).attachmentIds;
      attachments.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    }
    const sender = prepared ? prepared.sender : this.db.query(`SELECT s.name FROM conversations c
      JOIN messaging_sender_aliases a ON a.backend_id=c.backend_id AND a.alias=?
      JOIN messaging_senders s ON s.backend_id=a.backend_id AND s.id=a.sender_id WHERE c.id=?`).get(row.sender, row.conversation_id) as { name: string | null } | null;
    const account = prepared ? prepared.account : row.direction === "outgoing" && row.sender === "You"
      ? (this.db.query(`SELECT sender_id FROM messaging_accounts WHERE backend_id=(SELECT backend_id FROM conversations WHERE id=?)`).get(row.conversation_id) as { sender_id: string } | null)?.sender_id ?? null : null;
    const reply = this.reply(row);
    const action = this.db.query("SELECT action_id FROM messaging_action_requests WHERE request_id=?").get(row.id) as { action_id: string } | null;
    return { ...(action ? { actionId: action.action_id } : {}), id: row.id, seq: row.seq, requestId: row.request_body ? row.id : null, conversationId: row.conversation_id, externalId: row.external_id, direction: row.direction, sender: row.sender, ...(sender?.name ? { senderName: sender.name } : {}), text: row.text, timestamp: row.timestamp, status: row.status, error: row.error, attachments,
      ...((row.status === "received" || row.status === "sent") && row.external_id ? {
        identity: { id: messageReference({ transport: "messaging", messageId: row.id }), timestamp: row.timestamp, sender: { id: account ?? row.sender, ...(sender?.name ? { name: sender.name } : {}), ...(row.direction === "outgoing" ? { own: true } : {}) } },
      } : {}),
      reactions: prepared?.reactions ?? this.reactions(row),
      ...(reply ? { reply } : {}),
    };
  }
  private messages(rows: MessageRow[], conversationId: string): MessagingMessage[] {
    if (!rows.length) return [];
    if (rows.length > 100) {
      const messages: MessagingMessage[] = [];
      for (let start = 0; start < rows.length; start += 100) messages.push(...this.messages(rows.slice(start, start + 100), conversationId));
      return messages;
    }
    const conversation = this.conversationRow(conversationId);
    const placeholders = (count: number) => Array(count).fill("?").join(",");
    const ids = rows.map(row => row.id);
    const attached = this.db.query(`SELECT ma.message_id AS owner_id, a.* FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id IN (${placeholders(ids.length)}) ORDER BY a.rowid`).all(...ids) as (AttachmentRow & { owner_id: string })[];
    const attachments = new Map<string, MessagingAttachment[]>();
    for (const item of attached) {
      const list = attachments.get(item.owner_id) ?? [];
      list.push(this.attachment(item));
      attachments.set(item.owner_id, list);
    }
    const timestamps = [...new Set(rows.map(row => row.timestamp))];
    const events = this.db.query(`SELECT * FROM messaging_reactions WHERE backend_id=? AND conversation_external_id=? AND target_timestamp IN (${placeholders(timestamps.length)}) ORDER BY event_timestamp DESC,rowid DESC`)
      .all(conversation.backend_id, conversation.external_id, ...timestamps) as ReactionRow[];
    const byTimestamp = new Map<number, ReactionRow[]>();
    for (const event of events) {
      const list = byTimestamp.get(event.target_timestamp) ?? [];
      list.push(event);
      byTimestamp.set(event.target_timestamp, list);
    }
    const aliases = [...new Set([...rows.map(row => row.sender), ...events.flatMap(event => [event.account, event.sender, event.target_author])])];
    const contacts = this.db.query(`SELECT a.alias, a.sender_id, s.name FROM messaging_sender_aliases a
      JOIN messaging_senders s ON s.backend_id=a.backend_id AND s.id=a.sender_id
      WHERE a.backend_id=? AND a.alias IN (${placeholders(aliases.length)})`).all(conversation.backend_id, ...aliases) as { alias: string; sender_id: string; name: string | null }[];
    const byAlias = new Map(contacts.map(contact => [contact.alias, contact]));
    const canonical = (id: string) => byAlias.get(id)?.sender_id ?? id;
    const names = new Map(contacts.map(contact => [contact.sender_id, contact.name]));
    const account = this.db.query("SELECT sender_id FROM messaging_accounts WHERE backend_id=?").get(conversation.backend_id) as { sender_id: string } | null;
    return rows.map(row => {
      const sender = byAlias.get(row.sender);
      return this.message(row, {
        attachments: attachments.get(row.id) ?? [],
        sender: sender ? { name: sender.name } : null,
        account: row.direction === "outgoing" && row.sender === "You" ? account?.sender_id ?? null : null,
        reactions: this.reactions(row, { conversation, events: byTimestamp.get(row.timestamp) ?? [], canonical, names }),
      });
    });
  }
  history(conversationId: string, before?: number, limit = 60, since?: number): MessagingHistory {
    return { ...this.historyWindow(conversationId, before, limit, since), revision: this.conversationRow(conversationId).revision };
  }
  /** `from` is the sequence of the oldest message the client holds; older changes stay with pages it has not loaded. */
  changes(conversationId: string, after: number, from = 0): MessagingHistoryChanges {
    const { revision } = this.conversationRow(conversationId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(from) || from < 0) throw new MessagingFailure("Invalid message revision");
    const rows = this.db.query("SELECT * FROM messages WHERE conversation_id=? AND revision>? AND seq>=? ORDER BY seq ASC").all(conversationId, after, from) as MessageRow[];
    const removed = this.db.query("SELECT message_id FROM message_removals WHERE conversation_id=? AND revision>? AND seq>=?").all(conversationId, after, from) as { message_id: string }[];
    return { messages: this.messages(rows, conversationId), removed: removed.map(row => row.message_id), revision };
  }
  private historyWindow(conversationId: string, before?: number, limit = 60, since?: number): Omit<MessagingHistory, "revision"> {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new MessagingFailure("Invalid message cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MessagingFailure("Message limit must be between 1 and 100");
    if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new MessagingFailure("Invalid message timestamp");
    if (before !== undefined && since !== undefined) throw new MessagingFailure("before and since cannot be combined");
    if (since !== undefined) {
      const recent = this.db.query("SELECT seq FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?").get(conversationId, limit - 1) as { seq: number } | null;
      const dated = this.db.query("SELECT MIN(seq) AS seq FROM messages WHERE conversation_id=? AND timestamp>=?").get(conversationId, since) as { seq: number | null };
      const start = Math.min(recent?.seq ?? 0, dated.seq ?? Number.MAX_SAFE_INTEGER);
      const rows = this.db.query("SELECT * FROM messages WHERE conversation_id=? AND seq>=? ORDER BY seq ASC").all(conversationId, start) as MessageRow[];
      const more = rows.length > 0 && !!this.db.query("SELECT 1 FROM messages WHERE conversation_id=? AND seq<? LIMIT 1").get(conversationId, rows[0].seq);
      return { messages: this.messages(rows, conversationId), before: more ? rows[0].seq : null };
    }
    const rows = this.db.query("SELECT * FROM messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?").all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as MessageRow[];
    const more = rows.length > limit;
    if (more) rows.pop();
    return { messages: this.messages(rows.reverse(), conversationId), before: more ? rows[0].seq : null };
  }
  private attachmentRow(id: string): AttachmentRow {
    const row = this.db.query("SELECT * FROM attachments WHERE id=?").get(id) as AttachmentRow | null;
    if (!row) throw new MessagingFailure("Messaging attachment not found", 404);
    return row;
  }
  async upload(req: Request, conversationId: string, name: string): Promise<MessagingAttachment> {
    const conversation = this.conversationRow(conversationId);
    if (!this.readyBackend(conversation.backend_id).info.capabilities.attachments) throw new MessagingFailure("This backend does not support attachments");
    const id = crypto.randomUUID();
    const directory = join(this.root, "attachments", id);
    try {
      const file = await storeUpload(req, name, directory, MAX_ATTACHMENT_BYTES);
      const mimeType = (req.headers.get("content-type") || "application/octet-stream").split(";", 1)[0];
      this.db.query("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)").run(id, conversationId, null, uploadName(name), mimeType, file.size, file.path);
      return { id, name: uploadName(name), mimeType, size: file.size };
    } catch (cause) { rmSync(directory, { recursive: true, force: true }); throw cause; }
  }
  removeAttachment(id: string) {
    const row = this.attachmentRow(id);
    if (row.message_id) {
      if (this.db.query("SELECT id FROM messages WHERE id=? AND status='failed'").get(row.message_id)) return;
      throw new MessagingFailure("Sent message attachments cannot be removed from a draft", 409);
    }
    this.db.query("DELETE FROM attachments WHERE id=?").run(id);
    rmSync(join(this.root, "attachments", id), { recursive: true, force: true });
  }
  /** Send and wait for the backend's answer: the settled receipt. */
  send(conversationId: string, input: MessagingSend): Promise<MessagingMessage> {
    return this.accept(conversationId, input).settled;
  }
  /**
   * Take custody of a send. `message` is the durable receipt the moment the
   * row exists, already `sending`; `settled` resolves when the backend has
   * answered. A client that holds the receipt has nothing left to keep: the
   * outcome reaches it through the snapshot version like any other change,
   * and a failed send keeps its text on the message for recovery.
   */
  accept(conversationId: string, input: MessagingSend, authenticatedThreadId: string | null = null): { message: MessagingMessage; settled: Promise<MessagingMessage> } {
    const row = this.conversationRow(conversationId);
    if (!input || typeof input.requestId !== "string" || !ID.test(input.requestId) || typeof input.text !== "string" || input.text.length > 200_000
      || !Array.isArray(input.attachmentIds) || input.attachmentIds.length > 32 || input.attachmentIds.some(id => typeof id !== "string")
      || new Set(input.attachmentIds).size !== input.attachmentIds.length || (!input.text.trim() && !input.attachmentIds.length)
      || !validPurpose(input)
      || Object.hasOwn(input, "source")
      || (input.replyTo !== undefined && (typeof input.replyTo !== "string" || !parseMessageReference(input.replyTo)))) throw new MessagingFailure("Valid requestId, reply reference and a message or attachments are required");
    const body = JSON.stringify({ conversationId, text: input.text, attachmentIds: input.attachmentIds, ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}), ...(input.intentKey !== undefined ? { intentKey: input.intentKey } : {}), ...(input.followup !== undefined ? { followup: input.followup } : {}) });
    const existing = this.db.query("SELECT * FROM messages WHERE id=?").get(input.requestId) as MessageRow | null;
    if (existing) {
      if (existing.request_body !== body) throw new MessagingFailure("This requestId belongs to a different message", 409);
      const projection = this.db.query("SELECT action_id FROM messaging_action_requests WHERE request_id=?").get(input.requestId) as { action_id: string } | null;
      const inspected = projection ? this.actions.inspect(projection.action_id) : null;
      const message = inspected?.ok ? this.projectMessageAction(existing, inspected.value) : this.message(existing);
      return { message, settled: this.sends.get(input.requestId) ?? Promise.resolve(message) };
    }
    const reference = input.replyTo ? parseMessageReference(input.replyTo) : null;
    if (input.replyTo && reference?.transport !== "messaging") throw new MessagingFailure("Reply target must be a messaging message", 400);
    const target = reference?.transport === "messaging" ? this.db.query("SELECT * FROM messages WHERE id=? AND conversation_id=? AND status IN ('received','sent') AND external_id IS NOT NULL")
      .get(reference.messageId, conversationId) as MessageRow | null : null;
    if (input.replyTo && !target) throw new MessagingFailure("Reply target must be a confirmed message in this conversation", 409);
    const reply: BackendReply | undefined = target ? { author: this.messageSender(target, row.backend_id), timestamp: target.timestamp, text: target.text } : undefined;
    const attachments = input.attachmentIds.map(id => this.attachmentRow(id));
    if (attachments.some(item => item.conversation_id !== conversationId)) throw new MessagingFailure("Attachments must belong to this conversation's draft or a confirmed failed send", 409);
    const payload = this.effectPayload(row, input.text, attachments, reply);
    const reservation = this.reserve(row, input.requestId, input.intentKey ?? `signal.message:${digest(payload)}`, payload, input.followup, authenticatedThreadId);
    if (reservation.disposition !== "created" || reservation.action.state !== "accepted") {
      const prior = this.db.query("SELECT m.* FROM messages m JOIN messaging_action_requests r ON r.request_id=m.id WHERE r.action_id=? AND r.kind='message' ORDER BY m.seq LIMIT 1").get(reservation.action.id) as MessageRow | null;
      if (prior && reservation.disposition === "existing") {
        const message = this.projectMessageAction(prior, reservation.action);
        return { message, settled: this.sends.get(prior.id) ?? Promise.resolve(message) };
      }
      if (reservation.disposition !== "existing" || reservation.action.state !== "accepted") throw new MessagingFailure(`Action ${reservation.action.id} is ${reservation.action.state}; recipient contact is unresolved. Inspect and reconcile it, do not retry.`, 409, "action_fenced");
    }
    if (attachments.some(item => item.message_id && !(this.db.query("SELECT id FROM messages WHERE id=? AND status='failed'").get(item.message_id)))) throw new MessagingFailure("Attachments must belong to this conversation's draft or a confirmed failed send", 409);
    const backend = this.readyBackend(row.backend_id);
    if (input.attachmentIds.length && !backend.info.capabilities.attachments) throw new MessagingFailure("This backend does not support attachments");
    const timestamp = Date.now();
    this.db.transaction(() => {
      this.db.query("INSERT INTO messaging_action_requests VALUES(?,?,NULL,'message')").run(input.requestId, reservation.action.id);
      this.db.query("INSERT INTO messages(id,conversation_id,direction,sender,text,timestamp,status,request_body,quote_author,quote_timestamp,quote_text,quote_message_id) VALUES(?,?,'outgoing','You',?,?,'sending',?,?,?,?,?)").run(input.requestId, conversationId, input.text, timestamp, body, reply?.author ?? null, reply?.timestamp ?? null, reply?.text ?? null, target?.id ?? null);
      for (const item of attachments) {
        this.db.query("UPDATE attachments SET message_id=? WHERE id=?").run(input.requestId, item.id);
        this.db.query("INSERT INTO message_attachments VALUES(?,?)").run(input.requestId, item.id);
      }
      this.db.query("UPDATE conversations SET updated_at=MAX(updated_at,?) WHERE id=?").run(timestamp, conversationId);
    })();
    this.changed();
    const message = this.message(this.db.query("SELECT * FROM messages WHERE id=?").get(input.requestId) as MessageRow);
    const task = this.dispatch(backend.plugin, row, input, attachments, reservation.action.id, reply);
    this.sends.set(input.requestId, task);
    void task.then(() => this.sends.delete(input.requestId), () => this.sends.delete(input.requestId));
    return { message, settled: task };
  }
  private async dispatch(plugin: MessagingPlugin, conversation: ConversationRow, input: MessagingSend, attachments: AttachmentRow[], actionId: string, reply?: BackendReply): Promise<MessagingMessage> {
    const claim = this.actions.claim(actionId, "messaging-owner");
    if (!claim.ok) {
      this.db.query("UPDATE messages SET status='unknown',error=? WHERE id=?").run(claim.message, input.requestId);
      this.changed();
      return this.message(this.db.query("SELECT * FROM messages WHERE id=?").get(input.requestId) as MessageRow);
    }
    this.db.query("UPDATE messaging_action_requests SET ticket=? WHERE request_id=?").run(JSON.stringify(claim.value), input.requestId);
    let ticket: ActionTicket | null;
    try {
      ticket = this.journal.begin({ action: `${conversation.backend_id}.message`, recipients: [conversation.title, conversation.external_id], summary: `${input.text} (${attachments.length} attachments)`, externalId: input.requestId });
    } catch (cause) {
      this.actions.finish(claim.value, "failed-before-effect", null, { kind: "provider-rejection", reference: "dispatch-not-started", detail: `Local journal rejected before provider invocation: ${failureText(cause)}` });
      this.db.query("UPDATE messages SET status='failed',error=? WHERE id=?").run(`Not dispatched: action journal unavailable: ${failureText(cause)}`, input.requestId);
      this.changed();
      return this.message(this.db.query("SELECT * FROM messages WHERE id=?").get(input.requestId) as MessageRow);
    }
    const dispatch = this.actions.dispatch(claim.value);
    if (!dispatch.ok) {
      this.db.query("UPDATE messages SET status='unknown',error=? WHERE id=?").run(dispatch.message, input.requestId);
      this.changed();
      return this.message(this.db.query("SELECT * FROM messages WHERE id=?").get(input.requestId) as MessageRow);
    }
    try {
      const result = await plugin.send({ id: conversation.external_id, title: conversation.title, kind: conversation.kind }, { requestId: input.requestId, text: input.text, attachments: attachments.map(item => ({ path: item.path, name: item.name, mimeType: item.mime_type, size: item.size })), ...(reply ? { reply } : {}) });
      const authority = this.finishAction(claim.value, result);
      if (result.ok) {
        const redundant: AttachmentRow[] = [];
        this.db.transaction(() => {
          const synced = this.db.query("SELECT id FROM messages WHERE conversation_id=? AND external_id=? AND id<>?").get(conversation.id, result.value.externalId, input.requestId) as { id: string } | null;
          if (synced) {
            if (attachments.length) redundant.push(...this.db.query("SELECT * FROM attachments WHERE message_id=?").all(synced.id) as AttachmentRow[]);
            else {
              this.db.query("UPDATE attachments SET message_id=? WHERE message_id=?").run(input.requestId, synced.id);
              this.db.query("INSERT OR IGNORE INTO message_attachments SELECT ?,attachment_id FROM message_attachments WHERE message_id=?").run(input.requestId, synced.id);
            }
            this.db.query("DELETE FROM message_attachments WHERE message_id=?").run(synced.id);
            for (const item of redundant) this.db.query("DELETE FROM attachments WHERE id=?").run(item.id);
            this.db.query("UPDATE messages SET quote_message_id=? WHERE quote_message_id=?").run(input.requestId, synced.id);
            this.db.query("DELETE FROM messages WHERE id=?").run(synced.id);
          }
          this.db.query("UPDATE messages SET external_id=?,timestamp=?,status='sent',error=NULL WHERE id=?").run(result.value.externalId, result.value.timestamp, input.requestId);
          this.db.query("UPDATE conversations SET updated_at=COALESCE((SELECT MAX(timestamp) FROM messages WHERE conversation_id=?),0) WHERE id=?").run(conversation.id, conversation.id);
        })();
        for (const item of redundant) {
          try { rmSync(join(this.root, "attachments", item.id), { recursive: true, force: true }); }
          catch (cause) {
            const backend = this.backends.get(conversation.backend_id)!;
            this.setStatus(backend, "error", `Message sent, but duplicate attachment cleanup failed: ${failureText(cause)}`);
          }
        }
      } else this.db.query("UPDATE messages SET status=?,error=? WHERE id=?").run(result.error.code === "unknown" ? "unknown" : "failed", result.error.message, input.requestId);
      if (authority) this.db.query("UPDATE messages SET error=? WHERE id=?").run(authority, input.requestId);
    } catch (cause) {
      this.finishAction(claim.value, { ok: false, error: { code: "unknown", message: failureText(cause) } });
      this.db.query("UPDATE messages SET status='unknown',error=? WHERE id=?").run(`Backend did not confirm the send: ${failureText(cause)}`, input.requestId);
    }
    const row = this.db.query("SELECT * FROM messages WHERE id=?").get(input.requestId) as MessageRow;
    const outcomes = { sent: "confirmed", failed: "failed", unknown: "unconfirmed" } as const;
    if (row.status !== "sent" && row.status !== "failed" && row.status !== "unknown") throw new MessagingFailure("Unsupported outgoing send settlement state", 502, "protocol");
    const warning = journalWarning(this.journal.finish(ticket, outcomes[row.status], row.external_id ?? row.error ?? row.status));
    if (warning) this.db.query("UPDATE messages SET error=? WHERE id=?").run(warning, input.requestId);
    this.changed();
    return this.message(this.db.query("SELECT * FROM messages WHERE id=?").get(input.requestId) as MessageRow);
  }
  private async receive(backendId: string, value: BackendMessage): Promise<void> {
    if (value.direction !== "incoming" && value.direction !== "outgoing") throw new MessagingFailure("Unsupported messaging message direction", 502, "protocol");
    const conversation = this.upsertConversation(backendId, value.conversation);
    if (!value.id || !Number.isFinite(value.timestamp)) throw new Error("Backend returned an invalid message identity");
    if (value.reply && (!value.reply.author || !Number.isSafeInteger(value.reply.timestamp) || value.reply.timestamp <= 0 || typeof value.reply.text !== "string")) throw new Error("Backend returned an invalid reply");
    if (this.db.query("SELECT id FROM messages WHERE conversation_id=? AND external_id=?").get(conversation.id, value.id)) return;
    const files: Array<BackendAttachment & { id: string }> = [];
    try {
      for (const item of value.attachments) {
        if (!isAbsolute(item.path) || !statSync(item.path).isFile()) throw new Error("Backend attachment must be a local regular file");
        const id = crypto.randomUUID();
        const directory = join(this.root, "attachments", id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, uploadName(item.name));
        files.push({ ...item, id, path });
        copyFileSync(item.path, path);
        files[files.length - 1].size = statSync(path).size;
      }
      this.db.transaction(() => {
        if (this.db.query("SELECT id FROM messages WHERE conversation_id=? AND external_id=?").get(conversation.id, value.id)) throw new Error("Duplicate receive in progress");
        const id = crypto.randomUUID();
        this.db.query("INSERT INTO messages(id,conversation_id,external_id,direction,sender,text,timestamp,status,quote_author,quote_timestamp,quote_text) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, conversation.id, value.id, value.direction, value.sender, value.text, value.timestamp, value.direction === "incoming" ? "received" : "sent", value.reply?.author ?? null, value.reply?.timestamp ?? null, value.reply?.text ?? null);
        for (const item of files) {
          this.db.query("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)").run(item.id, conversation.id, id, uploadName(item.name), item.mimeType, item.size, item.path);
          this.db.query("INSERT INTO message_attachments VALUES(?,?)").run(id, item.id);
        }
        this.db.query("UPDATE conversations SET updated_at=MAX(updated_at,?) WHERE id=?").run(value.timestamp, conversation.id);
      })();
      this.changed();
    } catch (cause) { for (const item of files) rmSync(join(this.root, "attachments", item.id), { recursive: true, force: true }); throw cause; }
  }
  handle(req: Request, authenticatedThreadId: string | null = null): Promise<Response | null> {
    const task = this.handleRequest(req, authenticatedThreadId);
    this.requests.add(task);
    void task.then(() => this.requests.delete(task), () => this.requests.delete(task));
    return task;
  }
  private async handleRequest(req: Request, authenticatedThreadId: string | null): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/agent-signal" && !url.pathname.startsWith("/v1/agent-signal/")) return null;
    if (this.closing) return json({ error: "Messaging is handing over" }, 503);
    try {
      if (API.messaging.match(req.method, url.pathname)) return json(this.snapshot());
      const reaction = API.messagingReact.match(req.method, url.pathname);
      if (reaction) {
        const body = await req.json();
        if (!body || typeof body !== "object" || Object.hasOwn(body, "source")) throw new MessagingFailure("An agent reaction body is required");
        const receipt = await this.react(reaction.messageId, body.emoji, body.remove === undefined ? false : body.remove, body.requestId, body.intentKey, body.followup, authenticatedThreadId);
        return json(receipt, receipt.ok ? 200 : receipt.error.code === "message_not_found" ? 404 : receipt.error.code === "request_conflict" || receipt.error.code === "unknown" || receipt.error.code === "action_fenced" || receipt.error.code === "action_payload-conflict" ? 409 : receipt.error.code === "closed" || receipt.error.code === "backend_unavailable" || receipt.error.code === "journal_unavailable" || receipt.error.code === "action_unavailable" ? 503 : 400);
      }
      if (API.messagingOpen.match(req.method, url.pathname)) {
        const body = await req.json();
        if (typeof body.backendId !== "string" || typeof body.target !== "string") throw new MessagingFailure("backendId and target are required");
        return json({ conversation: await this.open(body.backendId, body.target) });
      }
      const history = API.messagingHistory.match(req.method, url.pathname);
      if (history) {
        const since = url.searchParams.get("since");
        if (since !== null && !/^(0|[1-9]\d*)$/.test(since)) throw new MessagingFailure("Invalid message timestamp");
        const after = url.searchParams.get("after");
        if (after !== null) {
          const from = url.searchParams.get("from");
          if (!/^(0|[1-9]\d*)$/.test(after) || (from !== null && !/^(0|[1-9]\d*)$/.test(from))) throw new MessagingFailure("Invalid message revision");
          return json(this.changes(history.conversationId, Number(after), from === null ? 0 : Number(from)));
        }
        return json(this.history(history.conversationId, url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined, url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 60, since === null ? undefined : Number(since)));
      }
      const send = API.messagingSend.match(req.method, url.pathname);
      if (send) {
        // Answer with the durable receipt, not the backend's verdict: Signal's
        // servers take most of a second, and the client already shows the
        // message as sending. The outcome follows on the snapshot version.
        const accepted = this.accept(send.conversationId, await req.json(), authenticatedThreadId);
        return json({ message: accepted.message }, accepted.message.status === "sending" ? 202 : 200);
      }
      const upload = API.messagingUpload.match(req.method, url.pathname);
      if (upload) {
        return json({ attachment: await this.upload(req, upload.conversationId, url.searchParams.get("name") || "attachment") }, 201);
      }
      const attachment = API.messagingAttachment.match(req.method, url.pathname);
      if (attachment) {
        const file = this.attachmentRow(attachment.attachmentId);
        if (!existsSync(file.path)) throw new MessagingFailure("Attachment file is missing", 404);
        // Pictures, voice notes and videos play in place and can seek; other types download.
        const inline = inlineSafe(file.mime_type);
        return servedFileResponse(file.path, req.method, req, {
          name: file.name,
          contentType: inline ? file.mime_type : "application/octet-stream",
          disposition: inline && url.searchParams.get("download") !== "1" ? "inline" : "attachment",
          cacheControl: file.message_id && this.db.query("SELECT status FROM messages WHERE id=? AND status IN ('sent','received')").get(file.message_id)
            ? "private, max-age=31536000, immutable" : "private, no-store",
          etag: `"${file.id}"`,
        });
      }
      const remove = API.messagingRemoveAttachment.match(req.method, url.pathname);
      if (remove) { this.removeAttachment(remove.attachmentId); return json({ ok: true }); }
      const link = API.messagingLink.match(req.method, url.pathname);
      if (link) {
        const body = await req.json().catch(() => ({}));
        if (body.deviceName !== undefined && typeof body.deviceName !== "string") throw new MessagingFailure("deviceName must be a string");
        return json({ link: await this.startLink(link.backendId, body.deviceName ?? "") });
      }
      const cancelLink = API.messagingCancelLink.match(req.method, url.pathname);
      if (cancelLink) return json({ link: await this.cancelLink(cancelLink.backendId) });
      return json({ error: "Messaging route not found" }, 404);
    } catch (cause) {
      return json({ error: failureText(cause), ...(cause instanceof MessagingFailure && cause.code ? { code: cause.code, ...(cause.action ? { action: cause.action } : {}) } : {}) }, cause instanceof MessagingFailure ? cause.status : 400);
    }
  }
  close(): Promise<void> {
    return this.closeTask ??= (async () => {
      this.closing = true;
      for (const backend of this.backends.values()) {
        if (backend.retry) { clearTimeout(backend.retry); backend.retry = undefined; }
      }
      const closing = await Promise.allSettled([...this.backends.values()].map(backend => backend.plugin?.close()));
      await this.started;
      await Promise.allSettled([...this.sends.values(), ...this.receives, ...this.requests]);
      // A link that completed during shutdown may have installed a replacement
      // connection; stop whatever each backend holds now.
      closing.push(...await Promise.allSettled([...this.backends.values()].map(backend => backend.plugin?.close())));
      const errors = closing.filter(result => result.status === "rejected");
      if (errors.length) throw new Error(`Messaging cleanup failed: ${errors.map(result => failureText(result.reason)).join("; ")}`);
      this.db.close();
      if (this.ownsActions) this.actions.close();
      this.closed = true;
    })().catch(cause => { this.closeTask = null; throw cause; });
  }
}
