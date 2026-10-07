import type { Result } from "pi-orchestrator/api";
import type { QuestionsResource, ThreadQuestion } from "./protocol";
import type { ClientStream } from "./stream";

type SettledQuestions = Exclude<QuestionsResource, { state: "loading" }>;

export class QuestionFeed {
  private readonly reads = new Map<string, Promise<SettledQuestions>>();
  private readonly snapshots = new Map<string, SettledQuestions>();

  constructor(private readonly read: (sessionId: string) => Promise<Result<ThreadQuestion[]>>) {}

  async settle(sessionId: string): Promise<void> {
    await this.reads.get(sessionId);
  }

  private refresh(sessionId: string): Promise<SettledQuestions> {
    const active = this.reads.get(sessionId);
    if (active) return active;
    const read = (async (): Promise<SettledQuestions> => {
      const previous = this.snapshots.get(sessionId);
      let snapshot: SettledQuestions;
      try {
        const result = await this.read(sessionId);
        snapshot = result.ok
          ? { state: "ready", questions: result.value }
          : { state: "failed", questions: previous?.questions ?? [], error: result.error.message };
      } catch (cause) {
        snapshot = { state: "failed", questions: previous?.questions ?? [], error: cause instanceof Error ? cause.message : String(cause) };
      }
      this.snapshots.set(sessionId, snapshot);
      return snapshot;
    })();
    this.reads.set(sessionId, read);
    void read.finally(() => this.reads.delete(sessionId));
    return read;
  }

  async send(stream: ClientStream): Promise<void> {
    const sessionId = stream.subscription.session;
    if (!sessionId) return;
    // A refresh is not a loss of the last settled snapshot.
    if (!this.snapshots.has(sessionId)) stream.publish({ type: "questions", sessionId, state: "loading", questions: [] });
    const snapshot = await this.refresh(sessionId);
    if (!stream.closed && stream.subscription.session === sessionId) stream.publish({ type: "questions", sessionId, ...snapshot });
  }
}
