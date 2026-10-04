import type { EditorState } from "./file-editor";

export type FileDraft = Extract<EditorState, { phase: "editing" }>;

export class FileDraftStore {
  private drafts = new Map<string, Map<string, FileDraft>>();
  keep(scope: string, state: EditorState) {
    if (state.phase !== "editing" || state.draft === state.document.content) return;
    const files = this.drafts.get(scope) ?? new Map<string, FileDraft>();
    files.delete(state.path);
    files.set(state.path, {
      ...state, busy: null,
      problem: state.busy === "save" ? { error: "Save was not confirmed. Reload to check the file before retrying.", conflict: false } : state.problem,
    });
    this.drafts.set(scope, files);
  }
  peek(scope: string) { return [...(this.drafts.get(scope)?.values() ?? [])].at(-1); }
  take(scope: string, path: string | null) {
    if (!path) return undefined;
    const files = this.drafts.get(scope);
    const draft = files?.get(path);
    if (!draft) return undefined;
    files!.delete(path);
    if (!files!.size) this.drafts.delete(scope);
    return draft;
  }
  hasDraft() { return this.drafts.size > 0; }
  clear() { this.drafts.clear(); }
}

export const fileDrafts = new FileDraftStore();
let listening = false;
export function fileDraftScope() {
  if (!listening) {
    listening = true;
    window.addEventListener("pi-person", () => fileDrafts.clear());
    window.addEventListener("pi-auth", () => { if (!window.PiRemotePerson.session()) fileDrafts.clear(); });
    window.addEventListener("beforeunload", event => {
      if (!fileDrafts.hasDraft()) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }
  return `${window.PiRemotePerson.get()}\n${window.KenanRemote?.resolveApiUrl("/v1/files/edit") ?? window.location.origin}`;
}
