import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionClient } from "./action-client.js";
export { ActionClient } from "./action-client.js";


export type ActionState = "accepted" | "inflight" | "succeeded" | "failed-before-effect" | "uncertain" | "held";
export type ActionEvidence = { kind: "provider-receipt" | "provider-rejection" | "operator-observation"; reference: string; detail: string };
export type ActionInput = { intentKey: string; recipients: string[]; transport: string; payload: unknown; requestId: string; threadId: string; authenticatedThreadId?: string | null };
export type ActionRecord = { id: string; owner: string; submittingThreadId: string | null; intentKey: string; recipients: string[]; transport: string; payload: unknown; state: ActionState; revision: number; result: unknown; evidence: ActionEvidence | null; resolved: boolean; createdAt: number; updatedAt: number };
export type ActionTicket = { id: string; token: string; revision: number };
export type ActionSubmission = { action: ActionRecord; disposition: "created" | "existing" };
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: "invalid-input" | "payload-conflict" | "not-found" | "fenced" | "unavailable"; message: string; action?: ActionRecord };
type Row = { id: string; owner: string; submitting_thread_id: string | null; intent_key: string; recipients: string; transport: string; payload: string; digest: string; state: ActionState; revision: number; token: string | null; result: string; evidence: string | null; resolved: number; created_at: number; updated_at: number };
const fail = (error: Exclude<ActionResult<never>, { ok: true }>['error'], message: string, action?: ActionRecord): ActionResult<never> => ({ ok: false, error, message, ...(action ? { action } : {}) });
const good = <T>(value: T): ActionResult<T> => ({ ok: true, value });
const priorRefusal = (row: Row, recipient: string, error: "fenced" | "payload-conflict" = "fenced"): ActionResult<never> => fail(error, `blocked by unresolved prior action ${row.id} to ${recipient}; resolve-purpose it to continue${row.state === "succeeded" ? "" : "; an active or uncertain effect must first be settled with provider evidence"}`, record(row));
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1000;
function stable(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string" || typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object" && v !== null) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  throw new Error("Payload must be finite JSON");
}
export function canonicalRecipient(input: string): string {
  const raw = input.trim();
  const phone = raw.replace(/^(tel:|signal:)/i, "").replace(/[\s().-]/g, "");
  if (/^\+[1-9][0-9]{6,14}$/.test(phone)) return `tel:${phone}`;
  const mail = raw.replace(/^mailto:/i, "").match(/^(?:.*<)?([^<>\s]+@[^<>\s]+)>?$/);
  if (mail) return `mailto:${mail[1]!.toLowerCase()}`;
  return raw.normalize("NFKC");
}
function record(row: Row): ActionRecord {
  return { id: row.id, owner: row.owner, submittingThreadId: row.submitting_thread_id, intentKey: row.intent_key, recipients: JSON.parse(row.recipients), transport: row.transport, payload: JSON.parse(row.payload), state: row.state, revision: row.revision, result: JSON.parse(row.result), evidence: row.evidence ? JSON.parse(row.evidence) : null, resolved: row.resolved === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
function evidenceValid(v: ActionEvidence): boolean {
  return !!v && ["provider-receipt", "provider-rejection", "operator-observation"].includes(v.kind) && text(v.reference) && text(v.detail);
}

/** The action journal's dispatch authority. Transport databases project these decisions, never replace them. */
export class ActionStore {
  readonly db: Database;
  constructor(readonly directory: string, readonly owner: string) {
    if (!text(owner) || !directory.startsWith("/")) throw new Error("Explicit owner and absolute private action directory required");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "actions.sqlite3");
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS external_actions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,intent_key TEXT NOT NULL,recipients TEXT NOT NULL,transport TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('accepted','inflight','succeeded','failed-before-effect','uncertain','held')),revision INTEGER NOT NULL,token TEXT,result TEXT NOT NULL,evidence TEXT,resolved INTEGER NOT NULL CHECK(resolved IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner,intent_key,recipients));
      CREATE TABLE IF NOT EXISTS external_action_dispatches(owner TEXT NOT NULL,action_id TEXT NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(owner,action_id,revision));
      CREATE TABLE IF NOT EXISTS external_action_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,action_id TEXT NOT NULL,PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS external_recipient_aliases(owner TEXT NOT NULL,alias TEXT NOT NULL,group_id TEXT NOT NULL,PRIMARY KEY(owner,alias));
      CREATE TABLE IF NOT EXISTS external_contact_slots(owner TEXT NOT NULL,recipient TEXT NOT NULL,action_id TEXT NOT NULL,PRIMARY KEY(owner,recipient));
      CREATE TABLE IF NOT EXISTS external_contact_holds(owner TEXT NOT NULL,recipient TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(owner,recipient));
      CREATE TABLE IF NOT EXISTS external_action_events(seq INTEGER PRIMARY KEY,owner TEXT NOT NULL,action_id TEXT NOT NULL,at INTEGER NOT NULL,event TEXT NOT NULL,actor TEXT NOT NULL,evidence TEXT NOT NULL);`);
    const columns = this.db.query("PRAGMA table_info(external_actions)").all() as { name: string }[];
    if (!columns.some(column => column.name === "submitting_thread_id")) this.db.transaction(() => {
      const current = this.db.query("PRAGMA table_info(external_actions)").all() as { name: string }[];
      if (!current.some(column => column.name === "submitting_thread_id")) this.db.exec("ALTER TABLE external_actions ADD COLUMN submitting_thread_id TEXT");
    }).immediate();
  }
  close(): void { this.db.close(); }
  private run<T>(fn: () => ActionResult<T>): ActionResult<T> {
    try { return this.db.transaction(fn).immediate(); }
    catch (cause) { return fail("unavailable", `Action authority could not commit; no dispatch permitted: ${String(cause)}`); }
  }
  private row(id: string): Row | null { return this.db.query("SELECT * FROM external_actions WHERE owner=? AND id=?").get(this.owner, id) as Row | null; }
  private event(id: string, event: string, actor: string, evidence: unknown): void {
    this.db.query("INSERT INTO external_action_events(owner,action_id,at,event,actor,evidence) VALUES(?,?,?,?,?,?)").run(this.owner, id, Date.now(), event, actor, JSON.stringify(evidence));
  }
  private aliases(recipient: string): string[] {
    const identity = canonicalRecipient(recipient);
    const group = this.db.query("SELECT group_id FROM external_recipient_aliases WHERE owner=? AND alias=?").get(this.owner, identity) as { group_id: string } | null;
    return group ? (this.db.query("SELECT alias FROM external_recipient_aliases WHERE owner=? AND group_id=? ORDER BY alias").all(this.owner, group.group_id) as { alias: string }[]).map(row => row.alias) : [identity];
  }
  linkRecipients(identities: string[], actor: string): ActionResult<null> {
    if (!Array.isArray(identities) || identities.length < 2 || identities.length > 100 || !identities.every(text) || !text(actor)) return fail("invalid-input", "Verified recipient alias linking requires identities and actor");
    return this.run(() => {
      const linked = [...new Set(identities.flatMap(identity => this.aliases(identity)))].sort();
      if (linked.length > 1000) return fail("invalid-input", "Recipient alias group too large");
      const group = linked[0]!;
      for (const alias of linked) this.db.query("INSERT INTO external_recipient_aliases VALUES(?,?,?) ON CONFLICT(owner,alias) DO UPDATE SET group_id=excluded.group_id").run(this.owner, alias, group);
      const actions = new Set<string>(), reasons = new Set<string>();
      for (const alias of linked) {
        const slot = this.db.query("SELECT action_id FROM external_contact_slots WHERE owner=? AND recipient=?").get(this.owner, alias) as { action_id: string } | null;
        if (slot) actions.add(slot.action_id);
        const hold = this.db.query("SELECT reason FROM external_contact_holds WHERE owner=? AND recipient=?").get(this.owner, alias) as { reason: string } | null;
        if (hold) reasons.add(hold.reason);
      }
      if (actions.size > 1) reasons.add("Recipient aliases reveal conflicting unresolved effects; reconcile every prior action before another contact");
      if (actions.size === 1) for (const alias of linked) this.db.query("INSERT OR IGNORE INTO external_contact_slots VALUES(?,?,?)").run(this.owner, alias, [...actions][0]!);
      if (reasons.size) for (const alias of linked) this.db.query("INSERT INTO external_contact_holds VALUES(?,?,?) ON CONFLICT(owner,recipient) DO UPDATE SET reason=excluded.reason").run(this.owner, alias, [...reasons].join("; ").slice(0, 1000));
      this.event("recipient-alias", actions.size > 1 ? "aliases-conflict-held" : "aliases-linked", actor, { linked, actionIds: [...actions] });
      return good(null);
    });
  }
  inspect(id: string): ActionResult<ActionRecord> { return this.run(() => { const row = this.row(id); return row ? good(record(row)) : fail("not-found", "Action not found in this owner"); }); }
  list(): ActionResult<ActionRecord[]> { return this.run(() => good((this.db.query("SELECT * FROM external_actions WHERE owner=? ORDER BY created_at DESC LIMIT 100").all(this.owner) as Row[]).map(record))); }
  submit(input: ActionInput): ActionResult<ActionSubmission> {
    if (!input || !text(input.intentKey) || !text(input.transport) || !text(input.requestId) || !text(input.threadId) || input.authenticatedThreadId !== undefined && input.authenticatedThreadId !== null && !text(input.authenticatedThreadId) || !Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 100 || !input.recipients.every(text)) return fail("invalid-input", "Explicit intent, transport, recipients, request and thread identities required");
    let payload: string;
    try { payload = stable(input.payload); } catch { return fail("invalid-input", "Payload must be finite JSON"); }
    if (payload.length > 2_000_000) return fail("invalid-input", "Action payload too large");
    const key = input.intentKey.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    const digest = createHash("sha256").update(stable({ transport: input.transport, payload: JSON.parse(payload) })).digest("hex");
    return this.run<ActionSubmission>(() => {
      const recipients = [...new Set(input.recipients.flatMap(recipient => this.aliases(recipient)))].sort(), encoded = JSON.stringify(recipients);
      const request = this.db.query("SELECT action_id FROM external_action_requests WHERE owner=? AND request_id=?").get(this.owner, input.requestId) as { action_id: string } | null;
      const existing = request ? this.row(request.action_id) : (this.db.query("SELECT * FROM external_actions WHERE owner=? AND intent_key=?").all(this.owner, key) as Row[]).find(candidate => {
        const known = [...new Set((JSON.parse(candidate.recipients) as string[]).flatMap(recipient => this.aliases(recipient)))].sort();
        return JSON.stringify(known) === encoded;
      });
      if (existing) {
        const existingRecipients = [...new Set((JSON.parse(existing.recipients) as string[]).flatMap(recipient => this.aliases(recipient)))].sort();
        if (existing.digest !== digest || existing.intent_key !== key || JSON.stringify(existingRecipients) !== encoded) return existing.resolved ? fail("payload-conflict", "Existing intent/request has a different payload; inspect it, do not invent a retry identity", record(existing)) : priorRefusal(existing, existingRecipients[0]!, "payload-conflict");
        this.db.query("INSERT OR IGNORE INTO external_action_requests VALUES(?,?,?)").run(this.owner, input.requestId, existing.id);
        return good({ action: record(existing), disposition: "existing" });
      }
      for (const recipient of recipients) {
        const slot = this.db.query("SELECT action_id FROM external_contact_slots WHERE owner=? AND recipient=?").get(this.owner, recipient) as { action_id: string } | null;
        if (slot) {
          const prior = this.row(slot.action_id)!;
          if (prior.intent_key === key) {
            const known = [...new Set((JSON.parse(prior.recipients) as string[]).flatMap(identity => this.aliases(identity)))].sort();
            if (prior.digest !== digest || JSON.stringify(known) !== encoded) return priorRefusal(prior, recipient, "payload-conflict");
            this.db.query("INSERT OR IGNORE INTO external_action_requests VALUES(?,?,?)").run(this.owner, input.requestId, prior.id);
            return good({ action: record(prior), disposition: "existing" });
          }
          this.event(prior.id, "duplicate-contact-fenced", input.threadId, { requestId: input.requestId, intentKey: key, transport: input.transport });
          return priorRefusal(prior, recipient);
        }
      }
      const id = randomUUID(), now = Date.now();
      const hold = recipients.map(recipient => this.db.query("SELECT reason FROM external_contact_holds WHERE owner=? AND recipient=?").get(this.owner, recipient) as { reason: string } | null).find(Boolean);
      this.db.query("INSERT INTO external_actions(id,owner,intent_key,recipients,transport,payload,digest,state,revision,token,result,evidence,resolved,created_at,updated_at,submitting_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, this.owner, key, encoded, input.transport, payload, digest, hold ? "held" : "accepted", 1, null, "null", null, 0, now, now, input.authenticatedThreadId ?? null);
      this.db.query("INSERT INTO external_action_requests VALUES(?,?,?)").run(this.owner, input.requestId, id);
      for (const recipient of recipients) this.db.query("INSERT INTO external_contact_slots VALUES(?,?,?)").run(this.owner, recipient, id);
      this.event(id, hold ? "held" : "submitted", input.threadId, { requestId: input.requestId, reason: hold?.reason ?? null });
      return good({ action: record(this.row(id)!), disposition: "created" });
    });
  }
  claim(id: string, actor: string): ActionResult<ActionTicket> {
    if (!text(actor)) return fail("invalid-input", "Claim requires worker identity");
    return this.run(() => {
      const row = this.row(id);
      if (!row) return fail("not-found", "Action not found in this owner");
      if (row.state !== "accepted") return fail("fenced", "Only accepted actions may dispatch; no lease expiry or new UUID permits replay", record(row));
      for (const recipient of JSON.parse(row.recipients) as string[]) {
        if (this.db.query("SELECT reason FROM external_contact_holds WHERE owner=? AND recipient=?").get(this.owner, recipient)) return fail("fenced", "Recipient is held", record(row));
      }
      const token = randomUUID(), revision = row.revision + 1;
      this.db.query("UPDATE external_actions SET state='inflight',revision=?,token=?,updated_at=? WHERE id=? AND owner=?").run(revision, token, Date.now(), id, this.owner);
      this.event(id, "claimed", actor, { revision });
      return good({ id, token, revision });
    });
  }
  dispatch(ticket: ActionTicket): ActionResult<null> {
    return this.run(() => {
      const row = this.row(ticket.id);
      if (!row) return fail("not-found", "Action not found in this owner");
      if (row.state !== "inflight" || row.token !== ticket.token || row.revision !== ticket.revision) return fail("fenced", "Dispatch token is no longer current", record(row));
      if (this.db.query("SELECT 1 FROM external_action_dispatches WHERE owner=? AND action_id=? AND revision=?").get(this.owner, ticket.id, ticket.revision)) return fail("fenced", "This generation already entered provider dispatch; never send it again", record(row));
      for (const recipient of JSON.parse(row.recipients) as string[]) if (this.db.query("SELECT 1 FROM external_contact_holds WHERE owner=? AND recipient=?").get(this.owner, recipient)) return fail("fenced", "Recipient held during preparation", record(row));
      this.db.query("INSERT INTO external_action_dispatches VALUES(?,?,?,?)").run(this.owner, ticket.id, ticket.revision, Date.now());
      this.event(ticket.id, "provider-dispatch-entered", "transport", { revision: ticket.revision });
      return good(null);
    });
  }
  finish(ticket: ActionTicket, outcome: "succeeded" | "failed-before-effect" | "uncertain", result: unknown, evidence: ActionEvidence): ActionResult<ActionRecord> {
    if (!["succeeded", "failed-before-effect", "uncertain"].includes(outcome) || !evidenceValid(evidence)) return fail("invalid-input", "Outcome and evidence are required");
    if (outcome === "succeeded" && evidence.kind !== "provider-receipt") return fail("invalid-input", "Succeeded transition requires a positive provider receipt");
    if (outcome === "failed-before-effect" && evidence.kind !== "provider-rejection") return fail("invalid-input", "No-effect transition requires a confirmed pre-effect rejection");
    let encoded: string; try { encoded = stable(result); } catch { return fail("invalid-input", "Result must be finite JSON"); }
    return this.run(() => {
      const row = this.row(ticket.id);
      if (!row) return fail("not-found", "Action not found in this owner");
      if (row.state !== "inflight" || row.token !== ticket.token || row.revision !== ticket.revision) return fail("fenced", "Stale dispatch fence; inspect current action", record(row));
      this.db.query("UPDATE external_actions SET state=?,result=?,evidence=?,token=NULL,revision=revision+1,resolved=?,updated_at=? WHERE owner=? AND id=?").run(outcome, encoded, JSON.stringify(evidence), outcome === "failed-before-effect" ? 1 : 0, Date.now(), this.owner, row.id);
      if (outcome === "failed-before-effect") this.db.query("DELETE FROM external_contact_slots WHERE owner=? AND action_id=?").run(this.owner, row.id);
      this.event(row.id, outcome, "transport", evidence);
      return good(record(this.row(row.id)!));
    });
  }
  reconcile(id: string, expectedRevision: number, decision: "effect-confirmed" | "no-effect-confirmed" | "resolve-purpose" | "hold", evidence: ActionEvidence, actor: string): ActionResult<ActionRecord> {
    if (!evidenceValid(evidence) || !text(actor) || !Number.isSafeInteger(expectedRevision) || !["effect-confirmed", "no-effect-confirmed", "resolve-purpose", "hold"].includes(decision)) return fail("invalid-input", "Reconciliation requires exact revision, decision, actor and evidence");
    return this.run(() => {
      const row = this.row(id);
      if (!row) return fail("not-found", "Action not found in this owner");
      if (row.revision !== expectedRevision) return fail("fenced", "Reconciliation revision changed", record(row));
      // An inflight owner may still send. Reconciliation cannot steal its token or authorize a replay.
      if (row.state === "inflight") return fail("fenced", "Inflight dispatch must be settled or abandoned by its transport owner first", record(row));
      let state = row.state, resolved = row.resolved;
      switch (decision) {
        case "effect-confirmed":
          if (row.state !== "uncertain" || evidence.kind !== "provider-receipt") return fail("invalid-input", "Uncertain effects require a provider receipt");
          state = "succeeded"; break;
        case "no-effect-confirmed":
          if (!["uncertain", "held", "accepted", "failed-before-effect"].includes(row.state) || evidence.kind !== "provider-rejection") return fail("invalid-input", "Replaying requires affirmative provider rejection/no-effect proof, not absence of a receipt");
          state = "failed-before-effect"; resolved = 1; break;
        case "resolve-purpose":
          if (row.state !== "succeeded" && row.state !== "failed-before-effect") return fail("fenced", "Cannot resolve an uncertain or active effect into another contact", record(row));
          resolved = 1; break;
        case "hold":
          for (const recipient of JSON.parse(row.recipients) as string[]) this.db.query("INSERT INTO external_contact_holds VALUES(?,?,?) ON CONFLICT(owner,recipient) DO UPDATE SET reason=excluded.reason").run(this.owner, recipient, evidence.detail);
          if (row.state === "accepted") state = "held";
          break;
      }
      this.db.query("UPDATE external_actions SET state=?,resolved=?,evidence=?,revision=revision+1,updated_at=? WHERE owner=? AND id=?").run(state, resolved, JSON.stringify(evidence), Date.now(), this.owner, id);
      if (resolved) this.db.query("DELETE FROM external_contact_slots WHERE owner=? AND action_id=?").run(this.owner, id);
      this.event(id, decision, actor, evidence);
      return good(record(this.row(id)!));
    });
  }
  abandon(ticket: ActionTicket, evidence: ActionEvidence): ActionResult<ActionRecord> { return this.finish(ticket, "uncertain", null, evidence); }
  recover(id: string, expectedRevision: number, evidence: ActionEvidence, actor: string): ActionResult<ActionRecord> {
    if (!evidenceValid(evidence) || evidence.kind !== "operator-observation" || !text(actor)) return fail("invalid-input", "Recovery requires evidence that the owning sender instance has retired");
    return this.run(() => {
      const row = this.row(id);
      if (!row) return fail("not-found", "Action not found in this owner");
      if (row.revision !== expectedRevision || row.state !== "inflight") return fail("fenced", "Recovery requires the exact inflight generation", record(row));
      this.db.query("UPDATE external_actions SET state='uncertain',token=NULL,revision=revision+1,evidence=?,updated_at=? WHERE owner=? AND id=?").run(JSON.stringify(evidence), Date.now(), this.owner, id);
      this.event(id, "sender-retired-uncertain", actor, evidence);
      return good(record(this.row(id)!));
    });
  }
  retryNoEffect(id: string, expectedRevision: number, evidence: ActionEvidence, actor: string): ActionResult<ActionRecord> {
    if (!evidenceValid(evidence) || evidence.kind !== "provider-rejection" || !text(actor)) return fail("invalid-input", "Retry requires affirmative no-effect evidence");
    return this.run(() => {
      const row = this.row(id);
      if (!row) return fail("not-found", "Action not found in this owner");
      if (row.revision !== expectedRevision || row.state !== "failed-before-effect") return fail("fenced", "Retry only follows reconciled no-effect, never elapsed time or an unknown response", record(row));
      for (const recipient of [...new Set((JSON.parse(row.recipients) as string[]).flatMap(recipient => this.aliases(recipient)))]) {
        if (this.db.query("SELECT 1 FROM external_contact_slots WHERE owner=? AND recipient=?").get(this.owner, recipient) || this.db.query("SELECT 1 FROM external_contact_holds WHERE owner=? AND recipient=?").get(this.owner, recipient)) return fail("fenced", "Recipient already reserved or held", record(row));
      }
      this.db.query("UPDATE external_actions SET state='accepted',resolved=0,revision=revision+1,evidence=?,updated_at=? WHERE owner=? AND id=?").run(JSON.stringify(evidence), Date.now(), this.owner, id);
      for (const recipient of [...new Set((JSON.parse(row.recipients) as string[]).flatMap(recipient => this.aliases(recipient)))]) this.db.query("INSERT INTO external_contact_slots VALUES(?,?,?)").run(this.owner, recipient, id);
      this.event(id, "retry-no-effect", actor, evidence);
      return good(record(this.row(id)!));
    });
  }
  followup(priorId: string, expectedRevision: number, input: ActionInput, evidence: ActionEvidence): ActionResult<ActionSubmission> {
    if (!evidenceValid(evidence) || !input || !text(input.threadId)) return fail("invalid-input", "Followup requires accountable evidence and worker identity");
    return this.run<ActionSubmission>(() => {
      const prior = this.row(priorId);
      if (!prior) return fail("not-found", "Prior action not found in this owner");
      const linkedInput = { ...input, intentKey: `followup:${priorId}:${input.intentKey}` };
      const replay = this.db.query("SELECT action_id FROM external_action_requests WHERE owner=? AND request_id=?").get(this.owner, input.requestId) as { action_id: string } | null;
      const linkedRecipients = Array.isArray(input.recipients) && input.recipients.every(text) ? JSON.stringify([...new Set(input.recipients.flatMap(recipient => this.aliases(recipient)))].sort()) : null;
      const linkedKey = linkedInput.intentKey.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
      const linkedPrior = linkedRecipients ? this.db.query("SELECT 1 FROM external_actions WHERE owner=? AND intent_key=? AND recipients=?").get(this.owner, linkedKey, linkedRecipients) : null;
      if (replay || linkedPrior) return this.submit(linkedInput);
      if (prior.revision !== expectedRevision || !["succeeded", "failed-before-effect"].includes(prior.state)) return fail("fenced", "Followup requires exact reconciled prior effect, not uncertainty", record(prior));
      if (!Array.isArray(input.recipients) || !input.recipients.every(text)) return fail("invalid-input", "Followup requires recipient identities");
      const recipients = [...new Set(input.recipients.flatMap(recipient => this.aliases(recipient)))].sort();
      const priorRecipients = [...new Set((JSON.parse(prior.recipients) as string[]).flatMap(recipient => this.aliases(recipient)))].sort();
      if (JSON.stringify(recipients) !== JSON.stringify(priorRecipients)) return fail("invalid-input", "Followup must address the same recipient set");
      for (const recipient of recipients) {
        const slot = this.db.query("SELECT action_id FROM external_contact_slots WHERE owner=? AND recipient=?").get(this.owner, recipient) as { action_id: string } | null;
        if (slot && slot.action_id !== priorId) return priorRefusal(this.row(slot.action_id)!, recipient);
        if (this.db.query("SELECT 1 FROM external_contact_holds WHERE owner=? AND recipient=?").get(this.owner, recipient)) return fail("fenced", "Recipient hold still applies", record(prior));
      }
      // A savepoint makes releasing the old slot and reserving the new action indivisible.
      this.db.exec("SAVEPOINT followup");
      this.db.query("UPDATE external_actions SET resolved=1,revision=revision+1,updated_at=? WHERE owner=? AND id=?").run(Date.now(), this.owner, priorId);
      this.db.query("DELETE FROM external_contact_slots WHERE owner=? AND action_id=?").run(this.owner, priorId);
      const next = this.submit(linkedInput);
      if (!next.ok || next.value.disposition !== "created") this.db.exec("ROLLBACK TO followup");
      else this.event(priorId, "followup-authorized", input.threadId, { nextId: next.value.action.id, evidence });
      this.db.exec("RELEASE followup");
      return next;
    });
  }
  holdRecipient(recipient: string, reason: string, actor: string): ActionResult<null> {
    if (!text(recipient) || !text(reason) || !text(actor)) return fail("invalid-input", "Recipient hold requires identity, reason and actor");
    return this.run(() => { for (const alias of this.aliases(recipient)) this.db.query("INSERT INTO external_contact_holds VALUES(?,?,?) ON CONFLICT(owner,recipient) DO UPDATE SET reason=excluded.reason").run(this.owner, alias, reason); this.event("recipient-hold", "hold", actor, { recipient: canonicalRecipient(recipient), reason }); return good(null); });
  }
  releaseRecipient(recipient: string, evidence: ActionEvidence, actor: string): ActionResult<null> {
    if (!text(recipient) || !text(actor) || !evidenceValid(evidence)) return fail("invalid-input", "Hold release requires accountable evidence");
    return this.run(() => {
      for (const alias of this.aliases(recipient)) this.db.query("DELETE FROM external_contact_holds WHERE owner=? AND recipient=?").run(this.owner, alias);
      const held = this.db.query("SELECT * FROM external_actions WHERE owner=? AND state='held'").all(this.owner) as Row[];
      for (const row of held) {
        const blocked = (JSON.parse(row.recipients) as string[]).some(target => this.db.query("SELECT 1 FROM external_contact_holds WHERE owner=? AND recipient=?").get(this.owner, target));
        const dispatched = this.db.query("SELECT 1 FROM external_action_dispatches WHERE owner=? AND action_id=?").get(this.owner, row.id);
        if (!blocked && !dispatched) this.db.query("UPDATE external_actions SET state='accepted',revision=revision+1,updated_at=? WHERE owner=? AND id=?").run(Date.now(), this.owner, row.id);
      }
      this.event("recipient-hold", "release", actor, { recipient: canonicalRecipient(recipient), evidence }); return good(null);
    });
  }
}

export type ActionAuthority = Pick<ActionStore, "close" | "submit" | "inspect" | "list" | "claim" | "dispatch" | "finish" | "abandon" | "reconcile" | "recover" | "retryNoEffect" | "followup" | "holdRecipient" | "releaseRecipient" | "linkRecipients">;

export function actionRequest(store: ActionAuthority, operation: string, input: any): ActionResult<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || "owner" in input) return fail("invalid-input", "Action input must be an object; the canonical supervisor supplies owner identity");
  switch (operation) {
    case "submit": return store.submit(input);
    case "inspect": return store.inspect(input.id);
    case "list": return store.list();
    case "claim": return store.claim(input.id, input.actor);
    case "dispatch": return store.dispatch(input.ticket);
    case "finish": return store.finish(input.ticket, input.outcome, input.result, input.evidence);
    case "reconcile": return store.reconcile(input.id, input.expectedRevision, input.decision, input.evidence, input.actor);
    case "recover": return store.recover(input.id, input.expectedRevision, input.evidence, input.actor);
    case "retry": return store.retryNoEffect(input.id, input.expectedRevision, input.evidence, input.actor);
    case "followup": return store.followup(input.priorId, input.expectedRevision, input.input, input.evidence);
    case "hold-recipient": return store.holdRecipient(input.recipient, input.reason, input.actor);
    case "release-recipient": return store.releaseRecipient(input.recipient, input.evidence, input.actor);
    case "link-recipients": return store.linkRecipients(input.identities, input.actor);
    default: return fail("invalid-input", "Unknown action operation");
  }
}
export function openActionStore(env: NodeJS.ProcessEnv = process.env): ActionAuthority {
  if (env.PI_ACTION_AUTHORITY_LOCAL_FIXTURE !== "1") return new ActionClient(env.PI_REMOTE_SERVER_URL ?? `http://127.0.0.1:${env.PI_REMOTE_ROUTER_PORT ?? "8788"}`, undefined, env.PI_REMOTE_SERVER_URL ? env.PI_THREAD_TOKEN : undefined);
  const owner = env.PI_KENAN_MEMORY_PERSON ?? env.PI_KENAN_PERSON ?? env.PI_REMOTE_SENDER_ID ?? env.USER;
  let privateDir = env.PI_REMOTE_PRIVATE_DIR;
  if (!privateDir && env.PI_REMOTE_CONFIG) privateDir = JSON.parse(readFileSync(env.PI_REMOTE_CONFIG, "utf8")).unlock?.mountpoint;
  const directory = env.PI_KENAN_ACTION_JOURNAL_DIR ?? (privateDir ? join(privateDir, ".kenan-actions") : undefined);
  if (!owner || !directory || !directory.startsWith("/")) throw new Error("External actions require a known owner and their configured private action directory; no global fallback");
  return new ActionStore(directory, owner);
}
