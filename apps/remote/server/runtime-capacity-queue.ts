// One capacity probe serves every waiting thread. Polling this small control
// endpoint never opens a session or changes a thread's visible state.
export class RuntimeCapacityQueue {
  private waiting = new Map<string, {resume: () => void; priority: () => number}>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking = false;
  private stopped = false;
  constructor(private capacity: (priority: number) => Promise<number>, private interval = 2_000) {}
  has(id: string) { return this.waiting.has(id); }
  block(id: string, resume: () => void, priority = () => 0) {
    if (!this.waiting.has(id)) this.waiting.set(id, {resume,priority});
    this.schedule(this.interval);
  }
  cancel(id: string) { this.waiting.delete(id); }
  wake() { this.schedule(0); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.waiting.clear(); }
  private schedule(delay: number) {
    if (this.stopped || this.checking || !this.waiting.size) return;
    if (this.timer && delay > 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, delay);
  }
  async check() {
    if (this.stopped || this.checking || !this.waiting.size) return;
    this.checking = true;
    try {
      const ordered = [...this.waiting].sort((a,b)=>b[1].priority()-a[1].priority());
      const priority = ordered[0]![1].priority();
      const slots = Math.max(0, Math.floor(await this.capacity(priority)));
      if (this.stopped) return;
      for (const [id, entry] of ordered.filter(([,entry])=>entry.priority()===priority).slice(0, slots)) {
        if (this.waiting.get(id) !== entry) continue;
        this.waiting.delete(id);
        entry.resume();
      }
    } catch { /* A slow control channel is unavailable capacity, not a dead host. */ }
    finally { this.checking = false; this.schedule(this.interval); }
  }
}
