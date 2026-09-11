import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { Store } from "../store.js";
import { oauthCredential, providerOAuth, withSharedAuth } from "./shared-oauth.js";
import { acquireDirectoryLock } from "./directory-lock.js";
import { CodexMeterSampler } from "../meters-codex.js";
import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

type Row = Record<string, string | number | null>;
export interface TransferEndpoint { host: string; ledger: string; }
interface Facts { account: Row; meters: Row[]; usage: Row[]; leases: Row[]; controls: Row[]; }
export interface TransferPacket {
  version: 1; id: string; alias: string; source: TransferEndpoint; destination: TransferEndpoint;
  identity: string; createdAt: number; facts: Facts; credential: OAuthCredential;
}
interface TransferOut { type: "account-transfer-out"; packet: TransferPacket; }
export interface TransferDrain {
  type: "account-transfer-draining"; phase: "preparing"; id: string; alias: string;
  source: TransferEndpoint; destination: TransferEndpoint; identity: string; startedAt: number;
  eligibility: { account: Row; meters: Row[] }; blockers: string[]; currentMeters?: Row[];
}
interface TransferReceipt {
  type: "account-transfer-receipt"; id: string; alias: string; source: TransferEndpoint; destination: TransferEndpoint;
  identity: string; createdAt: number; completedAt: number;
}
const key = (id: string) => `account-transfer:${id}`;
const receiptKey = (id: string) => `account-transfer-received:${id}`;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const sameEndpoint = (a: TransferEndpoint, b: TransferEndpoint) => a.host === b.host && a.ledger === b.ledger;
export function transferEndpoint(ledger: string): TransferEndpoint {
  const machine = readFileSync("/etc/machine-id", "utf8").trim();
  return { host: `${hostname()}:${createHash("sha256").update(machine).digest("hex").slice(0, 16)}`, ledger: realpathSync(ledger) };
}
function identity(credential: OAuthCredential): string {
  try {
    const claims = JSON.parse(Buffer.from(credential.access.split(".")[1]!, "base64url").toString());
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id !== "string" || !id) throw new Error();
    return createHash("sha256").update(id).digest("hex");
  } catch { throw new Error("Credential has no stable Codex account identity"); }
}
function blockers(store: Store, alias: string, now: number): string[] {
  const leases = store.activeLeases(alias, 120_000, now).map(lease => `lease:${lease.id}`);
  const runs = store.db.prepare("SELECT id FROM run WHERE account_id=? AND state IN ('queued','starting','running')").all(alias) as {id: string}[];
  return [...leases, ...runs.map(run => `run:${run.id}`)];
}
function quotaReady(store: Store, alias: string, now: number, maxAgeMs: number, allowDisabled = false): boolean {
  const account = store.account(alias);
  const meters = store.latestMeters(alias);
  return Boolean(account && (account.enabled || allowDisabled) && account.use === "shared" && (!account.cooldownUntil || account.cooldownUntil <= now)
    && ["codex-5h", "codex-7d"].every(id => meters.some(meter => meter.meter_id === id && meter.used_percent < 100 && now - meter.observed_at <= maxAgeMs && meter.observed_at <= now + 60_000)));
}
function facts(store: Store, alias: string, now: number): Facts {
  const account = store.db.prepare("SELECT * FROM account WHERE id=?").get(alias) as Row;
  return {
    account,
    meters: store.db.prepare("SELECT * FROM meter WHERE account_id=?").all(alias) as Row[],
    usage: store.db.prepare("SELECT * FROM usage_hour WHERE account_id=?").all(alias) as Row[],
    leases: (store.db.prepare("SELECT * FROM lease WHERE account_id=?").all(alias) as Row[]).map(lease => ({...lease, ended_at: lease.ended_at ?? Math.min(now, Number(lease.heartbeat_at))})),
    controls: store.db.prepare("SELECT * FROM control WHERE key IN (?,?,?)").all(`account-use:${alias}`, `meter-error:${alias}`, `account-lifecycle:${alias}`) as Row[],
  };
}
function receipt(packet: TransferPacket): TransferReceipt {
  return { type: "account-transfer-receipt", id: packet.id, alias: packet.alias, source: packet.source, destination: packet.destination,
    identity: packet.identity, createdAt: packet.createdAt, completedAt: Date.now() };
}

export class AccountTransfer {
  constructor(readonly store: Store, readonly authPath: string, readonly endpoint: TransferEndpoint,
    private readonly refreshQuota?: (alias: string, signal: AbortSignal) => Promise<void>) {}

  private async refreshDrainedQuota(alias: string, signal: AbortSignal): Promise<void> {
    if (this.refreshQuota) return this.refreshQuota(alias, signal);
    const family = builtinProviders().find(provider => provider.id === "openai-codex")!;
    const sampler = new CodexMeterSampler(this.store, {auth: providerOAuth(family, this.authPath),
      meters: ORCHESTRATOR_CATALOG.meters.filter(meter => meter.provider === "openai-codex"), requestTimeoutMs: 10_000});
    signal.throwIfAborted();
    const reports = await sampler.sampleAccount(alias);
    signal.throwIfAborted();
    if (!["codex-5h", "codex-7d"].every(id => reports.some(report => report.meterId === id && report.outcome === "recorded")))
      throw new Error(`Post-drain meter refresh failed; source stays disabled: ${reports.map(report => report.outcome + (report.detail ? `: ${report.detail}` : "")).join(", ")}`);
  }

  async inspect(alias: string, signal: AbortSignal) {
    return withSharedAuth(this.authPath, signal, auth => {
      if (this.store.account(alias) || auth[alias]) throw new Error(`Destination already has account alias ${alias}`);
      return this.endpoint;
    });
  }

  async prepare(alias: string, destination: TransferEndpoint, signal: AbortSignal, maxAgeMs = 15 * 60_000): Promise<TransferPacket | TransferReceipt | TransferDrain> {
    if (sameEndpoint(this.endpoint, destination) || this.endpoint.host === destination.host) throw new Error("Transfer requires a different host");
    const release = await acquireDirectoryLock(`${this.authPath}.transfer`, signal, "Another account transfer is active");
    try {
    const prepared = await withSharedAuth(this.authPath, signal, (auth) => {
      const current = object(auth[alias]);
      if (current.type === "account-transfer-out" || current.type === "account-transfer-receipt") {
        const prior = current.type === "account-transfer-out" ? current.packet as TransferPacket : current as TransferReceipt;
        if (!sameEndpoint(prior.destination, destination)) throw new Error("Account already transferred or transferring to another destination");
        return prior;
      }
      const credential = oauthCredential(current);
      if (!credential) throw new Error(`No transferable credential for ${alias}`);
      const accountIdentity = identity(credential), now = Date.now();
      const draining = this.store.transaction((): TransferDrain => {
        const registered = this.store.account(alias);
        if (registered?.provider !== "openai-codex") throw new Error("Only Codex ownership transfer is supported");
        const saved = this.store.control(key(alias));
        const preparing = saved ? JSON.parse(saved) as TransferDrain : undefined;
        if (preparing && (!sameEndpoint(preparing.destination, destination) || preparing.identity !== accountIdentity)) throw new Error("Preparation already belongs to another destination or identity");
        if (!preparing && registered.use !== "shared") throw new Error("Account needs shared eligibility");
        const remaining = this.store.accounts().filter(account => account.id !== alias && account.provider === "openai-codex" && quotaReady(this.store, account.id, now, maxAgeMs));
        if (remaining.length < 2) throw new Error("Transfer would leave fewer than two eligible Codex accounts on the source");
        this.store.db.exec(`CREATE TRIGGER IF NOT EXISTS account_transfer_exclusive BEFORE UPDATE OF enabled ON account
          WHEN NEW.enabled=1 AND EXISTS (SELECT 1 FROM control WHERE key='account-transfer:'||NEW.id
            AND json_extract(value,'$.phase') IN ('preparing','outgoing','transferred'))
          BEGIN SELECT RAISE(ABORT,'account transferred away; source cannot enable it'); END;`);
        this.store.setAccountEnabled(alias, false);
        const state: TransferDrain = {...(preparing ?? {type: "account-transfer-draining", phase: "preparing", id: crypto.randomUUID(), alias,
          source: this.endpoint, destination, identity: accountIdentity, startedAt: now,
          eligibility: {account: this.store.db.prepare("SELECT * FROM account WHERE id=?").get(alias) as Row, meters: this.store.latestMeters(alias) as Row[]}}), blockers: blockers(this.store, alias, now)};
        this.store.setControl(key(alias), JSON.stringify(state));
        return state;
      });
      return draining;
    });
    if (!("type" in prepared) || prepared.type !== "account-transfer-draining" || prepared.blockers.length) return prepared;
    const checkedAt = Date.now();
    await this.refreshDrainedQuota(alias, signal);
    return await withSharedAuth(this.authPath, signal, (auth, save) => {
      const credential = oauthCredential(auth[alias]);
      const current = JSON.parse(this.store.control(key(alias)) ?? "null") as TransferDrain | null;
      if (!credential || !current || current.id !== prepared.id || !sameEndpoint(current.destination, destination)
        || identity(credential) !== current.identity || this.store.account(alias)?.enabled) throw new Error("Source transfer identity or drain state changed");
      const meters = this.store.latestMeters(alias) as Row[];
      const blocked = blockers(this.store, alias, Date.now());
      if (!quotaReady(this.store, alias, Date.now(), 15_000, true)
        || !["codex-5h", "codex-7d"].every(id => meters.some(meter => meter.meter_id === id && Number(meter.observed_at) >= checkedAt))) {
        blocked.push(...meters.map(meter => `quota:${meter.meter_id}=${meter.used_percent}%`));
        if (!meters.length) blocked.push("quota:missing post-drain readings");
      }
      if (blocked.length) {
        const drain = {...current, blockers: blocked, currentMeters: meters};
        this.store.setControl(key(alias), JSON.stringify(drain));
        return drain;
      }
      const packet: TransferPacket = {version: 1, id: current.id, alias, source: this.endpoint, destination,
        identity: current.identity, createdAt: current.startedAt, facts: facts(this.store, alias, Date.now()), credential};
      auth[alias] = {type: "account-transfer-out", packet} satisfies TransferOut;
      save();
      this.store.setControl(key(alias), JSON.stringify({phase: "outgoing", id: packet.id, destination, identity: packet.identity, startedAt: current.startedAt}));
      return packet;
    });
    } finally { release(); }
  }

  async receive(packet: TransferPacket, signal: AbortSignal): Promise<TransferReceipt> {
    if (packet?.version !== 1 || !packet.id || !packet.alias || !sameEndpoint(packet.destination, this.endpoint)
      || packet.source.host === this.endpoint.host || !oauthCredential(packet.credential) || identity(packet.credential) !== packet.identity)
      throw new Error("Invalid account transfer envelope or destination");
    if (packet.facts.account.id !== packet.alias || packet.facts.account.provider !== "openai-codex") throw new Error("Transfer identity does not match account facts");
    return withSharedAuth(this.authPath, signal, (auth, save) => {
      const recorded = this.store.control(receiptKey(packet.id));
      if (recorded) {
        const accepted = JSON.parse(recorded) as TransferReceipt;
        const currentCredential = oauthCredential(auth[packet.alias]);
        if (accepted.alias !== packet.alias || accepted.identity !== packet.identity || !sameEndpoint(accepted.source, packet.source)) throw new Error("Transfer receipt conflict");
        if (!currentCredential || identity(currentCredential) !== packet.identity) throw new Error("Received account identity changed; source outbox was retained");
        return accepted;
      }
      const importedKey = `account-transfer-imported:${packet.id}`;
      const imported = this.store.control(importedKey);
      let staged = object(auth[packet.alias]);
      let accepted: TransferReceipt;
      if (staged.type === "account-transfer-in" || imported) {
        accepted = imported ? JSON.parse(imported) : staged.receipt;
        const currentCredential = staged.type === "account-transfer-in" ? oauthCredential(staged.credential) : oauthCredential(staged);
        if (!accepted || accepted.id !== packet.id || accepted.alias !== packet.alias || accepted.identity !== packet.identity
          || !sameEndpoint(accepted.source, packet.source) || !currentCredential || identity(currentCredential) !== packet.identity)
          throw new Error("Transfer staging identity changed; destination credential was not replaced");
      } else {
        if (this.store.account(packet.alias) || auth[packet.alias]) throw new Error("Destination account alias collision");
        for (const value of Object.values(auth)) {
          const existing = oauthCredential(value);
          if (existing) {
            let existingIdentity: string | undefined;
            try { existingIdentity = identity(existing); } catch { continue; }
            if (existingIdentity === packet.identity) throw new Error("Destination already owns this Codex identity under another alias");
          }
        }
        accepted = receipt(packet);
        staged = {type: "account-transfer-in", receipt: accepted, credential: packet.credential};
        auth[packet.alias] = staged;
        save();
      }
      if (!imported) this.store.transaction(() => {
        if (this.store.account(packet.alias)) throw new Error("Destination account appeared during transfer");
        insertRows(this.store, "account", [{...packet.facts.account, enabled: 0}]);
        insertRows(this.store, "meter", packet.facts.meters);
        insertRows(this.store, "usage_hour", packet.facts.usage);
        insertRows(this.store, "lease", packet.facts.leases);
        for (const row of packet.facts.controls) this.store.setControl(String(row.key), String(row.value));
        this.store.setControl(importedKey, JSON.stringify(accepted));
        this.store.setControl(key(packet.alias), JSON.stringify({...accepted, phase: "receiving"}));
      });
      if (staged.type === "account-transfer-in") {
        auth[packet.alias] = staged.credential;
        save();
      }
      this.store.transaction(() => {
        this.store.setControl(receiptKey(packet.id), JSON.stringify(accepted));
        this.store.setControl(key(packet.alias), JSON.stringify({...accepted, phase: "received"}));
        this.store.setAccountEnabled(packet.alias, true);
      });
      return accepted;
    });
  }

  async finish(alias: string, accepted: TransferReceipt, signal: AbortSignal): Promise<TransferReceipt> {
    return withSharedAuth(this.authPath, signal, (auth, save) => {
      const current = object(auth[alias]);
      const packet = current.type === "account-transfer-out" ? current.packet as TransferPacket : current as TransferReceipt;
      if (packet.id !== accepted.id || packet.identity !== accepted.identity || !sameEndpoint(packet.destination, accepted.destination)) throw new Error("Destination receipt does not match outgoing transfer");
      auth[alias] = accepted;
      save();
      this.store.setControl(key(alias), JSON.stringify({...accepted, phase: "transferred"}));
      return accepted;
    });
  }

  async outgoing(alias: string, signal: AbortSignal): Promise<TransferPacket | TransferReceipt | undefined> {
    return withSharedAuth(this.authPath, signal, auth => {
      const value = object(auth[alias]);
      return value.type === "account-transfer-out" ? value.packet : value.type === "account-transfer-receipt" ? value as TransferReceipt : undefined;
    });
  }
}

const COLUMNS: Record<string, string[]> = {
  account: ["id", "provider", "label", "enabled", "cooldown_until", "concurrency", "last_admitted_meter_at", "created_at"],
  meter: ["account_id", "meter_id", "observed_at", "used_percent", "reset_at"],
  usage_hour: ["account_id", "hour", "source", "run_id", "model", "component", "tokens"],
  lease: ["id", "account_id", "kind", "run_id", "started_at", "heartbeat_at", "ended_at"],
};
function insertRows(store: Store, table: string, rows: Row[]) {
  const columns = COLUMNS[table]!;
  const statement = store.db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
  for (const row of rows) statement.run(...columns.map(column => row[column] ?? null));
}

export async function transferPeer(host: string, action: "inspect" | "receive", input: unknown, signal: AbortSignal): Promise<any> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host)) throw new Error("Transfer destination must be an SSH host alias");
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "pi-orchestrator", "account", "transfer-receive", action], {stdio: ["pipe", "pipe", "pipe"], signal});
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    child.on("error", () => reject(new Error(`Transfer peer ${action} transport failed; rerun the same transfer to recover`)));
    child.on("close", code => {
      if (code !== 0) { reject(new Error(`Transfer peer ${action} exited ${code}; inspect the destination transfer status, then rerun the same transfer`)); return; }
      try { const result = JSON.parse(output); if (result.error) reject(new Error(result.error)); else resolve(result); }
      catch { reject(new Error("Transfer peer returned an invalid receipt")); }
    });
    child.stdin.on("error", () => reject(new Error("Transfer peer closed its input; rerun the same transfer to recover")));
    child.stdin.end(JSON.stringify(input));
  });
}
