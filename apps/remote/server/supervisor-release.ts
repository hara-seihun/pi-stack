import type { Result } from "pi-orchestrator/api";
import { API } from "./api";

interface ReleaseResources {
  suspend(): void;
  detach(): Promise<Result<void>>;
  closeImages(): Promise<void>;
  stopServer(): void;
  closeDatabase(): void;
  exit(code: number): void;
}

export class SupervisorRelease {
  private state: "accepting" | "draining" | "failed" | "closed" = "accepting";
  private pending?: Promise<Result<void>>;

  constructor(private readonly resources: ReleaseResources) {}

  get releasing(): boolean { return this.state !== "accepting"; }

  accepts(method: string, pathname: string): boolean {
    return !this.releasing || API.patchSessionContext.match(method, pathname) !== null
      || API.replaceSessionContext.match(method, pathname) !== null;
  }

  release(code: number): Promise<Result<void>> {
    if (this.pending) return this.pending;
    if (this.state === "closed") return Promise.resolve({ ok: true, value: undefined });
    this.pending = this.drain(code).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async drain(code: number): Promise<Result<void>> {
    try {
      if (this.state === "accepting") this.resources.suspend();
      this.state = "draining";
      const detached = await this.resources.detach();
      if (!detached.ok) { this.state = "failed"; return detached; }
      await this.resources.closeImages();
      // Idle Pi sessions upload their final context during detach. Their HTTP
      // listener and database must outlive that shutdown hook.
      this.resources.stopServer();
      this.resources.closeDatabase();
      this.state = "closed";
      this.resources.exit(code);
      return { ok: true, value: undefined };
    } catch (cause) {
      this.state = "failed";
      return { ok: false, error: { code: "unavailable", message: cause instanceof Error ? cause.message : String(cause) } };
    }
  }
}
