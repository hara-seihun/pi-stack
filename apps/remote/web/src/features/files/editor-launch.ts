import { API } from "../../../../server/api";
import { api } from "../../client";
import { recordFeatureUsage } from "../../feature-usage";

export type EditorLaunch = { url: string; ticket: string };
export type EditorResult = { ok: true; value: EditorLaunch } | { ok: false; error: string };

export function editorLaunch(value: unknown): EditorResult {
  if (!value || typeof value !== "object") return { ok: false, error: "Invalid editor handoff" };
  const data = value as Record<string, unknown>;
  if (data.ok !== true || typeof data.url !== "string" || typeof data.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.ticket)) return { ok: false, error: "Invalid editor handoff" };
  try {
    const url = new URL(data.url);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/editor/open" || url.search || url.hash || url.username || url.password) return { ok: false, error: "Invalid editor origin" };
    return { ok: true, value: { url: url.href, ticket: data.ticket } };
  } catch { return { ok: false, error: "Invalid editor origin" }; }
}

type EditorOpenResult = { ok: true; presentation: "frame"; value: EditorLaunch } | { ok: true; presentation: "native" } | { ok: false; error: string };

export async function openPersonEditor(path: string | null, kind: "file" | "directory"): Promise<EditorOpenResult> {
  const identity = { user: window.PiRemotePerson.get(), session: window.PiRemotePerson.session() };
  try {
    const [config, environment] = await Promise.all([api("GET", API.editorInfo.path()), window.KenanRemote?.getState()]);
    if (environment && config.environmentId !== environment.id) return { ok: false, error: "Open Files on the selected environment's own Pi Stack router to use its editor" };
    const parsed = editorLaunch(await api(API.editor.method, API.editor.path(), { path, kind }));
    if (!parsed.ok) return parsed;
    if (identity.user !== window.PiRemotePerson.get() || identity.session !== window.PiRemotePerson.session()) return { ok: false, error: "Your session changed before the editor opened" };
    if (window.KenanRemote?.openEditor) {
      await window.KenanRemote.openEditor(parsed.value);
      recordFeatureUsage("editor");
      return { ok: true, presentation: "native" };
    }
    recordFeatureUsage("editor");
    return { ...parsed, presentation: "frame" };
  } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : "Could not open your editor" }; }
}
