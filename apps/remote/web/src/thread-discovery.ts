export type DiscoveryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

type DiscoveryState =
  | { kind: "queued" | "loading" | "resolved" }
  | { kind: "failed"; error: { code: string; message: string }; retryAt: number };

export class ThreadDiscovery<T> {
  private states = new Map<string, DiscoveryState>();
  private queue: string[] = [];
  private active = 0;
  private lifecycle: "active" | "disposed" = "active";

  constructor(private options: {
    known(id: string): boolean;
    load(id: string): Promise<DiscoveryResult<T>>;
    accept(value: T): void;
    changed(): void;
    now(): number;
  }) {}

  error(id: string): string | null {
    const state = this.states.get(id);
    return state?.kind === "failed" ? state.error.message : null;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.queue = [];
    this.states.clear();
  }

  discover(ids: string[]): void {
    if (this.lifecycle === "disposed") return;
    for (const id of ids) {
      if (this.options.known(id)) continue;
      const state = this.states.get(id);
      if (state && (state.kind !== "failed" || this.options.now() < state.retryAt)) continue;
      this.states.set(id, { kind: "queued" });
      this.queue.push(id);
    }
    this.pump();
  }

  private pump(): void {
    while (this.lifecycle === "active" && this.active < 4 && this.queue.length) {
      const id = this.queue.shift()!;
      if (this.options.known(id)) {
        this.states.set(id, { kind: "resolved" });
        continue;
      }
      this.active++;
      this.states.set(id, { kind: "loading" });
      void this.load(id);
    }
  }

  private async load(id: string): Promise<void> {
    let result: DiscoveryResult<T>;
    try {
      result = await this.options.load(id);
      if (this.lifecycle === "active" && result.ok) this.options.accept(result.value);
    } catch (cause) {
      result = { ok: false, error: { code: "request_failed", message: cause instanceof Error ? cause.message : String(cause) } };
    }
    this.active--;
    if (this.lifecycle === "disposed") return;
    this.states.set(id, result.ok ? { kind: "resolved" } : {
      kind: "failed", error: result.error, retryAt: this.options.now() + 30_000,
    });
    this.pump();
    this.options.changed();
  }
}
