import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { LIFE_ROOT_SUBJECT, type LifeEntity, type LifeEntityInput, type LifeImportReceipt, type LifePolicy, type LifePolicyInput, type LifeRequest, type LifeResult, type LifeSteering, type LifeValue, type LifeVersion } from "./life-contract.js";
import { conservativeLifePolicy } from "./life-policy.js";
import { validateLifeRequest } from "./life-validation.js";

type Lane = "entity" | "policy" | "coverage" | "steering" | "import";
type Actor = { person: string; threadId: string | null };
type Row = { revision: number; payload: string };
const invalid = (message: string): LifeResult<never> => ({ ok: false, error: "invalid-request", message });

export class LifeStore {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS life_keys(subject TEXT PRIMARY KEY, key BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS life_versions(subject TEXT NOT NULL, lane TEXT NOT NULL, record TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(subject,lane,record,revision));
      CREATE TABLE IF NOT EXISTS life_heads(subject TEXT NOT NULL, lane TEXT NOT NULL, record TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(subject,lane,record));`);
  }
  initializePersonPolicy(person: string): LifeResult<LifePolicy> {
    if (person === LIFE_ROOT_SUBJECT || person === "pi-rooms" || !person.trim()) return invalid("Only an individual person has an initial conservative policy");
    try {
      return this.db.transaction((): LifeResult<LifePolicy> => {
        const old = this.current<LifePolicy>(person, "policy", "authority");
        if (old) return { ok: true, value: old };
        const at = new Date().toISOString();
        const policy = this.version("authority", 1, { person: "system", threadId: null }, conservativeLifePolicy(person, at), at);
        this.append(person, "policy", policy);
        return { ok: true, value: policy };
      })();
    } catch { return { ok: false, error: "unavailable", message: "Life policy initialization could not complete" }; }
  }
  request(subject: string, actor: Actor, input: LifeRequest): LifeResult {
    const parsed = validateLifeRequest(input);
    if (!parsed.ok) return parsed;
    if (!subject.trim() || subject === "pi-rooms") return invalid("Life subject must be an individual or the explicit root aggregate");
    try { return this.db.transaction(() => this.dispatch(subject, actor, parsed.value))(); }
    catch { return { ok: false, error: "unavailable", message: "Life storage could not complete the operation" }; }
  }
  invalidateMemories(ids: string[]): LifeResult<{ invalidated: number }> {
    try {
      return this.db.transaction(() => {
        let invalidated = 0;
        const forgotten = new Set(ids);
        const subjects = this.db.query("SELECT subject FROM life_keys").all() as { subject: string }[];
        for (const { subject } of subjects) {
          const invalidLife = new Set<string>();
          let changed = true;
          while (changed) {
            changed = false;
            for (const entity of this.all<LifeEntity>(subject, "entity")) {
              if (entity.status !== "current" || !["derived", "hypothesis"].includes(entity.value.provenance.factClass)) continue;
              if (!entity.value.provenance.evidence.some(link => link.kind === "memory" && forgotten.has(link.id) || link.kind === "life" && invalidLife.has(link.id))) continue;
              const revision = entity.revision + 1;
              this.rewrite(subject, "entity", { ...entity, status: "superseded", supersededBy: revision });
              this.append(subject, "entity", { ...this.version(entity.id, revision, { person: "system", threadId: null }, entity.value), status: "retracted", supersededBy: null, retractionReason: "Supporting memory was deleted or stopped; this inference requires reconciliation" } as LifeEntity);
              invalidLife.add(entity.id); invalidated++; changed = true;
            }
          }
          const policy = this.current<LifePolicy>(subject, "policy", "authority");
          if (policy && policy.value.status === "active" && ["derived", "hypothesis"].includes(policy.value.provenance.factClass) && policy.value.provenance.evidence.some(link => link.kind === "memory" && forgotten.has(link.id) || link.kind === "life" && invalidLife.has(link.id))) {
            this.append(subject, "policy", this.version("authority", policy.revision + 1, { person: "system", threadId: null }, { ...policy.value, status: "revoked" } satisfies LifePolicyInput));
          }
        }
        return { ok: true as const, value: { invalidated } };
      })();
    } catch { return { ok: false, error: "unavailable", message: "Dependent life inference invalidation could not complete" }; }
  }
  private currentValidity(provenance: LifeEntityInput["provenance"]): boolean {
    const now = Date.now();
    return (provenance.validFrom === null || Date.parse(provenance.validFrom) <= now) && (provenance.validUntil === null || Date.parse(provenance.validUntil) > now);
  }
  private dispatch(subject: string, actor: Actor, request: LifeRequest): LifeResult {
    switch (request.operation) {
      case "read": return { ok: true, value: { subject, entities: this.all<LifeEntity>(subject, "entity").filter(entity => entity.status === "current" && (entity.value.kind !== "preference" || this.currentValidity(entity.value.provenance))), coverage: this.all(subject, "coverage") } as LifeValue };
      case "entity-history": return { ok: true, value: this.history<LifeEntity>(subject, "entity", request.id) };
      case "policy-read": return { ok: true, value: { subject, current: this.current<LifePolicy>(subject, "policy", "authority"), history: request.includeHistory ? this.history<LifePolicy>(subject, "policy", "authority") : [] } };
      case "policy-write": {
        if (request.policy.status === "active" && request.policy.provenance.factClass !== "stated") return invalid("Expanded authority must be a stated grant, never an inferred policy");
        const prior = this.current<LifePolicy>(subject, "policy", "authority");
        const conflict = this.cas(prior, request.expectedRevision);
        if (conflict) return conflict;
        const policy = this.version("authority", request.expectedRevision + 1, actor, request.policy);
        this.append(subject, "policy", policy);
        return { ok: true, value: policy };
      }
      case "put-entity": {
        const prior = this.current<LifeEntity>(subject, "entity", request.id);
        const conflict = this.cas(prior, request.expectedRevision);
        if (conflict) return conflict;
        if (prior && prior.value.kind !== request.entity.kind) return invalid("An entity cannot change kind");
        const relation = this.validateRelations(subject, request.id, request.entity, new Map());
        if (relation) return relation;
        const entity = this.putEntity(subject, actor, request.id, request.expectedRevision, request.entity);
        return { ok: true, value: entity };
      }
      case "retract-entity": {
        const prior = this.current<LifeEntity>(subject, "entity", request.id);
        const conflict = this.cas(prior, request.expectedRevision);
        if (conflict) return conflict;
        if (!prior) return { ok: false, error: "not-found", message: "Entity is not present" };
        if (prior.status !== "current") return invalid("Only a current entity may be retracted");
        const revision = request.expectedRevision + 1;
        this.rewrite(subject, "entity", { ...prior, status: "superseded", supersededBy: revision });
        const entity: LifeEntity = { ...this.version(request.id, revision, actor, prior.value), status: "retracted", supersededBy: null, retractionReason: request.reason };
        this.append(subject, "entity", entity);
        return { ok: true, value: entity };
      }
      case "coverage-write": {
        const prior = this.current<LifeVersion<unknown>>(subject, "coverage", request.coverage.source);
        const conflict = this.cas(prior, request.expectedRevision);
        if (conflict) return conflict;
        const coverage = this.version(request.coverage.source, request.expectedRevision + 1, actor, request.coverage);
        this.append(subject, "coverage", coverage);
        return { ok: true, value: coverage };
      }
      case "steering-read": return { ok: true, value: this.all<LifeSteering>(subject, "steering").sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id)).slice(0, request.limit) };
      case "steering-write": {
        const prior = this.current<LifeSteering>(subject, "steering", request.id);
        const conflict = this.cas(prior, request.expectedRevision);
        if (conflict) return conflict;
        const currentPolicy = this.current<LifePolicy>(subject, "policy", "authority");
        const starting = request.steering.state === "planned" || request.steering.state === "executing";
        const policy = this.history<LifePolicy>(subject, "policy", "authority").find(policy => policy.revision === request.steering.policyRevision);
        if (!policy || policy.value.status !== "active" || starting && (currentPolicy?.revision !== policy.revision || !this.currentValidity(policy.value.provenance))) return invalid("Starting steering requires current active authority; outcomes retain their original authority revision");
        const mode = policy.value.steering.mode;
        if (mode === "off" || request.steering.visibility === "silent" && mode !== "silent-permitted") return invalid("Steering visibility is outside current authority");
        for (const [ids, kind] of [[request.steering.goalIds, "goal"], [request.steering.preferenceIds, "preference"]] as const) {
          if (ids.some(id => { const entity = this.current<LifeEntity>(subject, "entity", id); return !entity || entity.status !== "current" || entity.value.kind !== kind || kind === "preference" && !this.currentValidity(entity.value.provenance); })) return invalid("Steering links must identify current goals and preferences in this aggregate");
        }
        if (prior && (prior.value.policyRevision !== request.steering.policyRevision || prior.value.action !== request.steering.action || prior.value.visibility !== request.steering.visibility)) return invalid("A steering effect cannot be reassigned to another policy, action or visibility");
        if (prior && !this.steeringTransition(prior.value.state, request.steering.state)) return invalid("Invalid steering effect transition");
        const steering = this.version(request.id, request.expectedRevision + 1, actor, request.steering);
        this.append(subject, "steering", steering);
        return { ok: true, value: steering };
      }
      case "import-receipt": {
        const receipt = this.current<LifeVersion<LifeImportReceipt>>(subject, "import", request.source);
        return receipt ? { ok: true, value: { ...receipt.value, status: "already-imported" } } : { ok: false, error: "not-found", message: "Source has not been imported" };
      }
      case "import-entities": {
        const prior = this.current<LifeVersion<LifeImportReceipt>>(subject, "import", request.source);
        if (prior) return { ok: true, value: { ...prior.value, status: "already-imported" } };
        if (!isAbsolute(request.source) || resolve(request.source) !== request.source) return invalid("Import source must be a canonical absolute path");
        const entries = new Map(request.entries.map(entry => [entry.id, entry.entity]));
        if (entries.size !== request.entries.length) return invalid("Import IDs must be unique");
        for (const entry of request.entries) {
          if (this.current(subject, "entity", entry.id)) return { ok: false, error: "conflict", message: "An import entity ID already exists" };
          const relation = this.validateRelations(subject, entry.id, entry.entity, entries);
          if (relation) return relation;
        }
        const at = new Date().toISOString();
        for (const entry of request.entries) this.putEntity(subject, actor, entry.id, 0, entry.entity);
        const receipt: LifeImportReceipt = { source: request.source, fingerprint: request.fingerprint, importedAt: at, ids: request.entries.map(entry => entry.id), status: "imported" };
        this.append(subject, "import", this.version(request.source, 1, actor, receipt, at));
        return { ok: true, value: receipt };
      }
    }
  }
  private steeringTransition(from: LifeSteering["value"]["state"], to: LifeSteering["value"]["state"]): boolean {
    const transitions = { planned: ["planned", "executing", "succeeded", "failed", "uncertain"], executing: ["executing", "succeeded", "failed", "uncertain"], uncertain: ["uncertain", "succeeded", "failed"], succeeded: ["succeeded"], failed: ["failed"] };
    return transitions[from].includes(to);
  }
  private validateRelations(subject: string, id: string, entity: LifeEntityInput, staged: Map<string, LifeEntityInput>): LifeResult<never> | null {
    const lookup = (id: string) => { const item = this.current<LifeEntity>(subject, "entity", id); return staged.get(id) ?? (item?.status === "current" ? item.value : null); };
    const expected: [string, LifeEntityInput["kind"]][] = [];
    if (entity.kind === "needs-you" && entity.commitmentId !== null) expected.push([entity.commitmentId, "commitment"]);
    if (entity.kind === "goal") expected.push(...entity.commitments.map(id => [id, "commitment"] as [string, "commitment"]));
    if (entity.kind === "commitment") {
      if (entity.goalId !== null) expected.push([entity.goalId, "goal"]);
      expected.push(...entity.dependencies.map(id => [id, "commitment"] as [string, "commitment"]));
      const seen = new Set<string>();
      const cyclic = (next: string): boolean => {
        if (next === id) return true;
        if (seen.has(next)) return false;
        seen.add(next);
        const dependency = lookup(next);
        return dependency?.kind === "commitment" && dependency.dependencies.some(cyclic);
      };
      if (entity.dependencies.some(cyclic)) return invalid("Commitment dependencies cannot form a cycle");
    }
    return expected.some(([link, kind]) => lookup(link)?.kind !== kind) ? invalid("Life entity links must identify current entities of the expected kind in this aggregate") : null;
  }
  private cas(prior: { revision: number } | null, expected: number): LifeResult<never> | null {
    const revision = prior === null ? 0 : prior.revision;
    return revision === expected ? null : { ok: false, error: "conflict", message: "Life revision changed; read before writing", currentRevision: revision };
  }
  private version<T>(id: string, revision: number, actor: Actor, value: T, recordedAt = new Date().toISOString()): LifeVersion<T> {
    return { id, revision, recordedAt, recordedBy: actor.person, threadId: actor.threadId, value };
  }
  private putEntity(subject: string, actor: Actor, id: string, expected: number, value: LifeEntityInput): LifeEntity {
    const revision = expected + 1;
    const prior = this.current<LifeEntity>(subject, "entity", id);
    if (prior) this.rewrite(subject, "entity", { ...prior, status: "superseded", supersededBy: revision });
    const entity: LifeEntity = { ...this.version(id, revision, actor, value), status: "current", supersededBy: null, retractionReason: null };
    this.append(subject, "entity", entity);
    return entity;
  }
  private key(subject: string, create: boolean): Buffer | null {
    const row = this.db.query("SELECT key FROM life_keys WHERE subject=?").get(subject) as { key: Uint8Array } | null;
    if (row) return Buffer.from(row.key);
    if (!create) return null;
    const key = randomBytes(32);
    this.db.query("INSERT INTO life_keys(subject,key) VALUES(?,?)").run(subject, key);
    return key;
  }
  private record(key: Buffer, lane: Lane, id: string) { return createHmac("sha256", key).update(JSON.stringify([lane, id])).digest("hex"); }
  private seal(key: Buffer, subject: string, lane: Lane, record: string, revision: number, value: unknown): string {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([subject, lane, record, revision])));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
  }
  private open<T>(key: Buffer, subject: string, lane: Lane, record: string, row: Row): T {
    const bytes = Buffer.from(row.payload, "base64"), cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    cipher.setAAD(Buffer.from(JSON.stringify([subject, lane, record, row.revision])));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8")) as T;
  }
  private current<T = LifeVersion<unknown>>(subject: string, lane: Lane, id: string): T | null {
    const key = this.key(subject, false);
    if (!key) return null;
    const record = this.record(key, lane, id);
    const row = this.db.query("SELECT v.revision,v.payload FROM life_heads h JOIN life_versions v USING(subject,lane,record,revision) WHERE h.subject=? AND h.lane=? AND h.record=?").get(subject, lane, record) as Row | null;
    return row ? this.open<T>(key, subject, lane, record, row) : null;
  }
  private history<T>(subject: string, lane: Lane, id: string): T[] {
    const key = this.key(subject, false);
    if (!key) return [];
    const record = this.record(key, lane, id);
    const rows = this.db.query("SELECT revision,payload FROM life_versions WHERE subject=? AND lane=? AND record=? ORDER BY revision DESC").all(subject, lane, record) as Row[];
    return rows.map(row => this.open<T>(key, subject, lane, record, row));
  }
  private all<T = LifeVersion<unknown>>(subject: string, lane: Lane): T[] {
    const key = this.key(subject, false);
    if (!key) return [];
    const rows = this.db.query("SELECT v.revision,v.payload,v.record FROM life_heads h JOIN life_versions v USING(subject,lane,record,revision) WHERE h.subject=? AND h.lane=? ORDER BY h.record").all(subject, lane) as (Row & { record: string })[];
    return rows.map(row => this.open<T>(key, subject, lane, row.record, row));
  }
  private append(subject: string, lane: Lane, version: LifeVersion<unknown>) {
    const key = this.key(subject, true)!;
    const record = this.record(key, lane, version.id);
    this.db.query("INSERT INTO life_versions(subject,lane,record,revision,payload) VALUES(?,?,?,?,?)").run(subject, lane, record, version.revision, this.seal(key, subject, lane, record, version.revision, version));
    this.db.query("INSERT INTO life_heads(subject,lane,record,revision) VALUES(?,?,?,?) ON CONFLICT(subject,lane,record) DO UPDATE SET revision=excluded.revision").run(subject, lane, record, version.revision);
  }
  private rewrite<T extends LifeVersion<unknown>>(subject: string, lane: Lane, version: T) {
    const key = this.key(subject, false)!;
    const record = this.record(key, lane, version.id);
    this.db.query("UPDATE life_versions SET payload=? WHERE subject=? AND lane=? AND record=? AND revision=?").run(this.seal(key, subject, lane, record, version.revision, version), subject, lane, record, version.revision);
  }
}
