import { afterEach, expect, test } from "bun:test";
import { FileEditor, MAX_EDIT_BYTES, requestFileEdit, type EditRequest, type EditResult, type EditorState } from "./src/features/files/file-editor";

import { FileDraftStore } from "./src/features/files/file-editor-drafts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

function fixture() {
  const calls: { path: string; signal: AbortSignal; document: Parameters<EditRequest>[2]; finish(result: EditResult): void }[] = [];
  const request: EditRequest = (path, signal, document) => new Promise(resolve => calls.push({ path, signal, document, finish: resolve }));
  const editor = new FileEditor(request);
  editor.activate("/fixture/shared.md");
  const document = { path: "/fixture/canonical.md", content: "initial\n", revision: "opaque-1" };
  const finish = (index: number, content = document.content, revision = document.revision) => calls[index].finish({ ok: true, document: { ...document, content, revision } });
  const editing = () => {
    const state = editor.snapshot();
    expect(state.phase).toBe("editing");
    return state as Extract<EditorState, { phase: "editing" }>;
  };
  return { editor, calls, document, finish, editing };
}

test("edit reads a fresh document, save uses its revision and requested symlink path, and preview gets the saved content", async () => {
  const f = fixture();
  const opened = f.editor.begin();
  expect(f.editor.snapshot().phase).toBe("loading");
  f.finish(0);
  await opened;
  expect(f.editor.dirty()).toBe(false);
  f.editor.change("changed\n");
  const saved = f.editor.save();
  expect(f.calls[1].path).toBe("/fixture/shared.md");
  expect(f.calls[1].document).toEqual({ ...f.document, content: "changed\n" });
  expect(f.editing().busy).toBe("save");
  f.editor.change("input during save must not be lost");
  expect(f.editing().draft).toBe("changed\n");
  f.finish(1, "changed\n", "opaque-2");
  await saved;
  expect(f.editor.snapshot().phase).toBe("idle");
  expect(f.editor.snapshot().document?.revision).toBe("opaque-2");
  expect(f.editor.snapshot().document?.content).toBe("changed\n");
  expect(f.editor.dirty()).toBe(false);
});

test("stale writes and failed reloads retain the draft and old revision until explicit successful reload", async () => {
  const f = fixture();
  const opened = f.editor.begin(); f.finish(0); await opened;
  f.editor.change("my draft");
  const saved = f.editor.save();
  f.calls[1].finish({ ok: false, error: "File changed", conflict: true });
  await saved;
  expect(f.editing().draft).toBe("my draft");
  expect(f.editing().document.revision).toBe("opaque-1");
  expect(f.editing().problem?.conflict).toBe(true);
  const failedReload = f.editor.reload();
  f.calls[2].finish({ ok: false, error: "Permission denied", conflict: false });
  await failedReload;
  expect(f.editing().draft).toBe("my draft");
  expect(f.editing().document.revision).toBe("opaque-1");
  const reload = f.editor.reload(); f.finish(3, "someone else's edit", "opaque-3"); await reload;
  expect(f.editing().draft).toBe("someone else's edit");
  expect(f.editing().document.revision).toBe("opaque-3");
  expect(f.editor.dirty()).toBe(false);
});

test("save failures preserve draft and cancel never writes", async () => {
  const f = fixture();
  const opened = f.editor.begin(); f.finish(0); await opened;
  f.editor.change("keep me");
  const saved = f.editor.save();
  f.calls[1].finish({ ok: false, error: "Disk is full", conflict: false });
  await saved;
  expect(f.editing().draft).toBe("keep me");
  expect(f.editing().busy).toBeNull();
  f.editor.cancel();
  expect(f.editor.snapshot().phase).toBe("idle");
  expect(f.editor.snapshot().document?.content).toBe("initial\n");
  expect(f.calls).toHaveLength(2);
});

test("late reads and writes cannot update another path, even after leaving and returning to the same file", async () => {
  const f = fixture();
  const oldOpen = f.editor.begin();
  f.editor.activate("/fixture/other.txt");
  expect(f.calls[0].signal.aborted).toBe(true);
  f.editor.activate("/fixture/shared.md");
  const freshOpen = f.editor.begin();
  f.finish(0, "obsolete"); await oldOpen;
  expect(f.editor.snapshot().phase).toBe("loading");
  f.finish(1, "current", "current-revision"); await freshOpen;
  f.editor.change("new draft");
  const saved = f.editor.save();
  f.editor.activate("/fixture/other.txt");
  f.finish(2, "new draft", "saved-revision"); await saved;
  expect(f.editor.snapshot()).toEqual({ phase: "idle", path: "/fixture/other.txt", document: null, problem: null });
});

test("unsupported/non-writable edit failures keep preview and UTF-8 byte limit rejects oversized drafts without a write", async () => {
  const f = fixture();
  const denied = f.editor.begin();
  f.calls[0].finish({ ok: false, error: "Not writable", conflict: false }); await denied;
  expect(f.editor.snapshot().phase).toBe("idle");
  expect(f.editor.snapshot().problem?.error).toBe("Not writable");
  const opened = f.editor.begin(); f.finish(1); await opened;
  f.editor.change("é".repeat(MAX_EDIT_BYTES / 2 + 1));
  await f.editor.save();
  expect(f.calls).toHaveLength(2);
  expect(f.editing().problem?.error).toContain("1 MiB");
  expect(f.editor.dirty()).toBe(true);
});

test("SPA unmount preserves separate person/environment drafts, including uncertain saves, and remount resumes the original revision", async () => {
  const f = fixture();
  const drafts = new FileDraftStore();
  const opened = f.editor.begin(); f.finish(0); await opened;
  f.editor.change("parked draft");
  const saving = f.editor.save();
  drafts.keep("person-a/environment-1", f.editor.snapshot());
  f.editor.dispose();
  f.finish(1, "late save", "r-late"); await saving;
  expect(drafts.peek("person-b/environment-1")).toBeUndefined();
  expect(drafts.peek("person-a/environment-2")).toBeUndefined();
  expect(drafts.take("person-a/environment-1", "/wrong-path")).toBeUndefined();
  const restored = drafts.take("person-a/environment-1", "/fixture/shared.md");
  expect(restored?.draft).toBe("parked draft");
  expect(restored?.busy).toBeNull();
  expect(restored?.problem?.error).toContain("not confirmed");
  const remount = new FileEditor();
  remount.activate("/fixture/shared.md", restored);
  expect(remount.dirty()).toBe(true);
  expect(remount.snapshot().document?.revision).toBe("opaque-1");
  expect(drafts.peek("person-a/environment-1")).toBeUndefined();
  drafts.keep("person-a/environment-1", remount.snapshot());
  drafts.clear();
  expect(drafts.peek("person-a/environment-1")).toBeUndefined();
});

test("transport preserves server errors and distinguishes conflicts while using the existing authenticated fetch door", async () => {
  globalThis.window = { PiRemotePerson: { session: () => "fixture-session" } } as unknown as Window & typeof globalThis;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (init?.method === "PUT") return Response.json({ error: "Revision changed" }, { status: 409 });
    return Response.json({ path: "/fixture/a.md", content: "fresh", revision: "r1" });
  }) as typeof fetch;
  const controller = new AbortController();
  const loaded = await requestFileEdit("/fixture/a.md", controller.signal);
  expect(loaded.ok).toBe(true);
  expect(calls[0].url).toBe("/v1/files/edit?path=%2Ffixture%2Fa.md");
  expect(calls[0].init?.cache).toBe("no-store");
  const saved = await requestFileEdit("/fixture/a.md", controller.signal, { path: "/fixture/a.md", content: "draft", revision: "r1" });
  expect(saved).toEqual({ ok: false, error: "Revision changed", conflict: true });
  expect(calls[1].url).toBe("/v1/files/edit");
  expect(JSON.parse(String(calls[1].init?.body))).toEqual({ path: "/fixture/a.md", content: "draft", revision: "r1" });
});
