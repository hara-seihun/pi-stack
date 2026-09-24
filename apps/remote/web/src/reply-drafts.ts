import type { ReplyTarget } from "./message-reply";

export class ReplyDrafts {
  private revisions = new Map<string, number>();

  constructor(private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, private key: (id: string) => string) {}

  load(id: string): ReplyTarget | null {
    try {
      const value = JSON.parse(this.storage.getItem(this.key(id)) || "null");
      return typeof value?.identity?.id === "string" && typeof value?.text === "string" ? value as ReplyTarget : null;
    } catch { return null; }
  }

  save(id: string, target: ReplyTarget | null): void {
    this.revisions.set(id, this.version(id) + 1);
    try { target ? this.storage.setItem(this.key(id), JSON.stringify(target)) : this.storage.removeItem(this.key(id)); } catch {}
  }

  version(id: string): number { return this.revisions.get(id) ?? 0; }

  /** A receipt settles the draft that was sent, not a newer choice in that chat. */
  accept(id: string, version: number): boolean {
    if (this.version(id) !== version) return false;
    this.save(id, null);
    return true;
  }
}
