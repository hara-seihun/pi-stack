export class ResourceCache<T> {
  private entries = new Map<string, { value: T; bytes: number; count: number; usedAt: number }>();
  private bytes = 0;
  private count = 0;

  constructor(private readonly limits: { entries: number; bytes: number; idleMs?: number }, private readonly now = Date.now) {}

  get size() { return this.entries.size; }
  get byteSize() { return this.bytes; }
  get entryCount() { return this.count; }
  *values(): IterableIterator<T> {
    for (const entry of this.entries.values()) yield entry.value;
  }
  *pairs(): IterableIterator<[string, T]> {
    for (const [key, entry] of this.entries) yield [key, entry.value];
  }

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

  set(key: string, value: T, bytes = JSON.stringify(value).length * 2, count = 1): boolean {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.limits.bytes ||
      !Number.isSafeInteger(count) || count < 1 || count > this.limits.entries) return false;
    this.delete(key);
    this.entries.set(key, { value, bytes, count, usedAt: this.now() });
    this.bytes += bytes;
    this.count += count;
    for (const oldest of this.entries.keys()) {
      if (this.count <= this.limits.entries && this.bytes <= this.limits.bytes) break;
      this.delete(oldest);
    }
    return this.entries.has(key);
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.count -= entry.count;
    }
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.count = 0;
  }
}
