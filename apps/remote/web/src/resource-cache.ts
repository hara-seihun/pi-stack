export class ResourceCache<T> {
  private entries = new Map<string, { value: T; bytes: number; usedAt: number }>();
  private bytes = 0;

  constructor(private readonly limits: { entries: number; bytes: number; idleMs?: number }, private readonly now = Date.now) {}

  get size() { return this.entries.size; }
  get byteSize() { return this.bytes; }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.limits.idleMs !== undefined && this.now() - entry.usedAt >= this.limits.idleMs) {
      this.delete(key);
      return undefined;
    }
    entry.usedAt = this.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes = JSON.stringify(value).length * 2): boolean {
    this.delete(key);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.limits.bytes) return false;
    this.entries.set(key, { value, bytes, usedAt: this.now() });
    this.bytes += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limits.entries && this.bytes <= this.limits.bytes) break;
      this.delete(oldest);
    }
    return this.entries.has(key);
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
