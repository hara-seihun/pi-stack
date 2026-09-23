export class PreviewQueue {
  private active = 0;
  private waiting = new Set<() => void>();

  constructor(private readonly limit = 2) {}

  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const cancel = () => {
        this.waiting.delete(start);
        resolve(null);
      };
      const start = () => {
        signal.removeEventListener("abort", cancel);
        this.waiting.delete(start);
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.values().next().value?.();
        });
      };
      if (this.active < this.limit) start();
      else {
        this.waiting.add(start);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
  }
}
