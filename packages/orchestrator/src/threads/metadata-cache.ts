export class MetadataCache<T> {
  private readonly entries = new Map<string, { key: string; value: T; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid metadata cache limits");
  }

  get size(): number { return this.entries.size; }
  get byteSize(): number { return this.bytes; }

  get(id: string, key: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.key !== key) { this.delete(id); return undefined; }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  set(id: string, key: string, value: T, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid metadata cache accounting");
    this.delete(id);
    if (bytes > this.maxBytes) return false;
    this.entries.set(id, { key, value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
    return true;
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  clear(): void { this.entries.clear(); this.bytes = 0; }
}
