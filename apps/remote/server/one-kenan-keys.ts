import { createCipheriv, createDecipheriv, randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Person } from "./persons";

type Box = { iv: string; tag: string; data: string };
type Wrapper = { salt: string; box: Box };
type DiskStore = { version: 1; wrappers: Record<string, Wrapper>; vault: Box };
export type CustodyResult = { ok: true } | { ok: false; status: number; error: string };
export type CustodyStatus = { locked: boolean; initialized: boolean; enrolled: string[]; mounted: string[]; missing: string[]; pending: string[] }; 
export type FolderMount = (person: Person, key: string) => Promise<CustodyResult>;

function seal(key: Buffer, plaintext: Buffer, context: string): Box {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function open(key: Buffer, box: Box, context: string): Buffer {
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(box.data, "base64")), cipher.final()]);
}
function wrappingKey(key: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => derive(key, Buffer.from(salt, "base64"), 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolve(derived)));
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class KenanKeys {
  private master: Buffer | null = null;
  private keys: Record<string, string> = Object.create(null);
  private disk: DiskStore | null;
  private mounted = new Set<string>();
  private pending = new Map<string, string>();
  private queue = Promise.resolve();

  constructor(private path: string, private people: Person[], private mount: FolderMount,
    private opened: (master: Buffer) => Promise<CustodyResult> = async () => ({ ok: true })) {
    this.disk = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    if (this.disk && (this.disk.version !== 1 || !this.disk.wrappers || !this.disk.vault)) throw new Error("Invalid Kenan custody store");
  }

  status(): CustodyStatus {
    const enrolled = Object.keys(this.disk?.wrappers ?? {}).sort();
    return { locked: !this.master, initialized: !!this.disk, enrolled, mounted: [...this.mounted].sort(), pending: [...this.pending.keys()].sort(),
      missing: this.people.filter(person => person.unlock && !enrolled.includes(person.user)).map(person => person.user).sort() };
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(fn);
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }

  async authenticate(user: string, key: string): Promise<CustodyResult> {
    return this.exclusive(async () => {
      const person = this.people.find(person => person.user === user);
      if (!person) return { ok: false, status: 403, error: "Unknown person" };
      if (!person.unlock) return { ok: false, status: 403, error: "One Kenan requires a folder key for every person" };
      if (!key || Buffer.byteLength(key) > 4096 || /[\r\n\0]/.test(key)) return { ok: false, status: 400, error: "Key required" };
      try {
        if (this.pending.has(user) && !equal(this.pending.get(user)!, key)) return { ok: false, status: 403, error: "Wrong key" };
        if (!this.master && this.disk) {
          const wrapper = this.disk.wrappers[user];
          if (!wrapper) {
            const checked = await this.mount(person, key);
            if (!checked.ok) return checked;
            this.mounted.add(user);
            this.pending.set(user, key);
            return { ok: true };
          }
          const wrapping = await wrappingKey(key, wrapper.salt);
          let candidate: Buffer;
          try { candidate = open(wrapping, wrapper.box, `one-kenan/master/${user}`); }
          catch { return { ok: false, status: 403, error: "Wrong key" }; }
          finally { wrapping.fill(0); }
          try {
            const keys = JSON.parse(open(candidate, this.disk.vault, "one-kenan/keys").toString("utf8"));
            if (!equal(keys[user] ?? "", key)) { candidate.fill(0); return { ok: false, status: 403, error: "Wrong key" }; }
            this.keys = keys;
            this.master = candidate;
          } catch { candidate.fill(0); return { ok: false, status: 503, error: "Kenan's custody store could not be opened" }; }
        }
        if (this.keys[user] !== undefined && !equal(this.keys[user]!, key)) return { ok: false, status: 403, error: "Wrong key" };
        {
          const mounted = await this.mount(person, key);
          if (!mounted.ok) return mounted;
          this.mounted.add(user);
        }
        await this.retain(user, key);
        for (const [pendingUser, pendingKey] of this.pending) {
          await this.retain(pendingUser, pendingKey);
          this.pending.delete(pendingUser);
        }
        const shared = await this.opened(this.master!);
        if (!shared.ok) return shared;
        // Opening custody mounts every enrolled folder; login never stops another person's work.
        for (const other of this.people) {
          if (!other.unlock || other.user === user || this.keys[other.user] === undefined) continue;
          const result = await this.mount(other, this.keys[other.user]!);
          if (!result.ok) return { ok: false, status: 503, error: `Kenan's custody is open, but ${other.user}'s folder could not mount: ${result.error}` };
          this.mounted.add(other.user);
        }
        return { ok: true };
      } catch { return { ok: false, status: 503, error: "Kenan's custody could not retain the key" }; }
    });
  }

  async unlockFromProvider(master: Buffer): Promise<CustodyResult> {
    return this.exclusive(async () => {
      if (!this.disk || master.length !== 32) return { ok: false, status: 503, error: "Master provider cannot open custody" };
      try {
        const keys = JSON.parse(open(master, this.disk.vault, "one-kenan/keys").toString("utf8"));
        this.master = Buffer.from(master);
        this.keys = keys;
        for (const [pendingUser, pendingKey] of this.pending) {
          await this.retain(pendingUser, pendingKey);
          this.pending.delete(pendingUser);
        }
        const shared = await this.opened(this.master);
        if (!shared.ok) return shared;
        for (const person of this.people) {
          if (!person.unlock || this.keys[person.user] === undefined || this.mounted.has(person.user)) continue;
          const result = await this.mount(person, this.keys[person.user]!);
          if (!result.ok) return result;
          this.mounted.add(person.user);
        }
        return { ok: true };
      } catch { return { ok: false, status: 503, error: "Master provider cannot open custody" }; }
    });
  }

  private async retain(user: string, key: string) {
    if (this.keys[user] !== undefined) return;
    const master = this.master ?? randomBytes(32);
    const salt = randomBytes(32).toString("base64");
    const wrapping = await wrappingKey(key, salt);
    const keys = { ...this.keys, [user]: key };
    const next: DiskStore = { version: 1, wrappers: { ...this.disk?.wrappers, [user]: { salt, box: seal(wrapping, master, `one-kenan/master/${user}`) } },
      vault: seal(master, Buffer.from(JSON.stringify(keys)), "one-kenan/keys") };
    wrapping.fill(0);
    this.persist(next);
    this.disk = next;
    this.keys = keys;
    this.master = master;
  }

  private persist(value: DiskStore) {
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(temporary, this.path);
      const directory = openSync(parent, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
