import { API } from "../../../../server/api";
import type { FileEditSnapshot } from "../../../../server/protocol";
import { piFetch } from "../../client";

export const MAX_EDIT_BYTES = 1_048_576;
export type FileDocument = FileEditSnapshot;
export type EditResult = { ok: true; document: FileDocument } | { ok: false; error: string; conflict: boolean };
export type EditRequest = (path: string, signal: AbortSignal, document?: FileDocument) => Promise<EditResult>;

type Problem = { error: string; conflict: boolean };
export type EditorState =
  | { phase: "idle" | "loading"; path: string | null; document: FileDocument | null; problem: Problem | null }
  | { phase: "editing"; path: string; document: FileDocument; draft: string; busy: null | "save" | "reload"; problem: Problem | null };

export async function requestFileEdit(path: string, signal: AbortSignal, document?: FileDocument): Promise<EditResult> {
  const route = document ? API.fileSave : API.fileEdit;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await piFetch(route.path({}, document ? {} : { path }), {
      method: route.method,
      headers: { accept: "application/json", ...(document ? { "content-type": "application/json" } : {}) },
      body: document ? JSON.stringify({ ...document, path }) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json();
    if (!response.ok) return { ok: false, error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`, conflict: response.status === 409 };
    if (typeof body.path !== "string" || typeof body.content !== "string" || typeof body.revision !== "string") {
      return { ok: false, error: "The server returned an invalid file document.", conflict: false };
    }
    return { ok: true, document: body };
  } catch (cause) {
    return { ok: false, error: document ? "Save was not confirmed. Your draft is kept; reload to check the file before retrying." : cause instanceof Error ? cause.message : "Could not read the file.", conflict: false };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export class FileEditor {
  private state: EditorState = { phase: "idle", path: null, document: null, problem: null };
  private listeners = new Set<() => void>();
  private operation: AbortController | null = null;
  private generation = 0;

  constructor(private request: EditRequest = requestFileEdit) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: EditorState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private stop() {
    this.generation++;
    this.operation?.abort();
    this.operation = null;
  }
  activate(path: string | null, draft?: Extract<EditorState, { phase: "editing" }>) {
    this.stop();
    this.publish(draft?.path === path ? { ...draft, busy: null } : { phase: "idle", path, document: null, problem: null });
  }
  dispose() { this.stop(); }
  dirty() { return this.state.phase === "editing" && this.state.draft !== this.state.document.content; }
  change(draft: string) {
    if (this.state.phase === "editing" && !this.state.busy) this.publish({ ...this.state, draft });
  }
  cancel() {
    if (this.state.phase === "editing" && this.state.busy) return;
    this.stop();
    this.publish({ phase: "idle", path: this.state.path, document: this.state.document, problem: null });
  }
  async begin() {
    const before = this.state;
    if (!before.path || before.phase !== "idle") return;
    this.publish({ ...before, phase: "loading", problem: null });
    await this.run(before.path, undefined, result => {
      this.publish(result.ok
        ? { phase: "editing", path: before.path!, document: result.document, draft: result.document.content, busy: null, problem: null }
        : { ...before, problem: result });
    });
  }
  async reload() {
    const before = this.state;
    if (before.phase !== "editing" || before.busy) return;
    this.publish({ ...before, busy: "reload", problem: null });
    await this.run(before.path, undefined, result => {
      this.publish(result.ok
        ? { ...before, document: result.document, draft: result.document.content, busy: null, problem: null }
        : { ...before, busy: null, problem: result });
    });
  }
  async save() {
    const before = this.state;
    if (before.phase !== "editing" || before.busy || !this.dirty()) return;
    if (new TextEncoder().encode(before.draft).length > MAX_EDIT_BYTES) {
      this.publish({ ...before, problem: { error: "The draft exceeds the 1 MiB UTF-8 limit.", conflict: false } });
      return;
    }
    this.publish({ ...before, busy: "save", problem: null });
    await this.run(before.path, { ...before.document, content: before.draft }, result => {
      this.publish(result.ok
        ? { phase: "idle", path: before.path, document: result.document, problem: null }
        : { ...before, busy: null, problem: result });
    });
  }
  private async run(path: string, document: FileDocument | undefined, apply: (result: EditResult) => void) {
    this.stop();
    const generation = this.generation;
    const controller = this.operation = new AbortController();
    const result = await this.request(path, controller.signal, document);
    if (generation !== this.generation || controller.signal.aborted || path !== this.state.path) return;
    this.operation = null;
    apply(result);
  }
}
