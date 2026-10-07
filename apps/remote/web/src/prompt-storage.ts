export type PromptStorageError = { kind: "unavailable" | "scope_changed"; message: string };
export type PromptStorageResult<T> = { ok: true; value: T } | { ok: false; error: PromptStorageError };
export type PromptStorageState<T> =
  | { kind: "loading" }
  | { kind: "ready"; owner: T }
  | { kind: "failed"; error: PromptStorageError }
  | { kind: "closed" };

/** Initialization never submits saved work. One attempt owns all concurrent callers. */
export class PromptStorage<T> {
  private revision = 0;
  private attempt: Promise<PromptStorageResult<T>> | null = null;
  private value: PromptStorageState<T> = { kind: "loading" };
  constructor(private readonly options: {
    open: (current: () => boolean) => Promise<PromptStorageResult<T>>;
    dispose: (owner: T) => void;
    changed: (state: PromptStorageState<T>) => void;
  }) {}
  get state(): PromptStorageState<T> { return this.value; }
  private publish(state: PromptStorageState<T>) { this.value = state; this.options.changed(state); }
  ensure(): Promise<PromptStorageResult<T>> {
    if (this.value.kind === "ready") return Promise.resolve({ ok: true, value: this.value.owner });
    if (this.value.kind === "closed") return Promise.resolve(this.changedScope());
    if (this.attempt) return this.attempt;
    const revision = this.revision;
    const current = () => revision === this.revision && this.value.kind !== "closed";
    this.publish({ kind: "loading" });
    const operation = Promise.resolve().then(async () => {
      if (!current()) return this.changedScope();
      let result: PromptStorageResult<T>;
      try { result = await this.options.open(current); }
      catch (error) { result = { ok: false, error: { kind: "unavailable", message: error instanceof Error ? error.message : String(error) } }; }
      if (!current()) {
        if (result.ok) this.options.dispose(result.value);
        return this.changedScope();
      }
      this.publish(result.ok ? { kind: "ready", owner: result.value } : { kind: "failed", error: result.error });
      return result;
    });
    this.attempt = operation;
    void operation.then(() => { if (this.attempt === operation) this.attempt = null; });
    return operation;
  }
  invalidate() {
    if (this.value.kind === "closed") return;
    this.revision++;
    this.attempt = null;
    if (this.value.kind === "ready") this.options.dispose(this.value.owner);
    this.publish({ kind: "loading" });
  }
  fail(message: string) {
    if (this.value.kind === "closed") return;
    this.invalidate();
    this.publish({ kind: "failed", error: { kind: "unavailable", message } });
  }
  close() {
    this.invalidate();
    this.publish({ kind: "closed" });
  }
  private changedScope(): PromptStorageResult<never> {
    return { ok: false, error: { kind: "scope_changed", message: "The prompt's person or environment changed. Your draft is retained; send it from the intended chat." } };
  }
}
