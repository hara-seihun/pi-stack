export class RuntimeAdmission {
  private active = 0;
  private queue: { priority: () => number; run: () => Promise<void> }[] = [];
  constructor(private readonly concurrency = 2) {}

  admit<T>(priority: () => number, start: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ priority, run: async () => {
        try { resolve(await start()); } catch (error) { reject(error); }
      }});
      queueMicrotask(() => this.drain());
    });
  }

  private drain() {
    this.queue.sort((a, b) => b.priority() - a.priority());
    while (this.active < this.concurrency && this.queue.length) {
      const next = this.queue.shift()!;
      this.active++;
      void next.run().finally(() => { this.active--; this.drain(); });
    }
  }
}
