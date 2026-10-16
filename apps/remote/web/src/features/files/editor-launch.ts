import { API } from "../../../../server/api";
import { api } from "../../client";
import { recordFeatureUsage } from "../../feature-usage";

export type EditorLaunch = { url: string; ticket: string };
let opened: { popup: Window; user: string; session: string } | null = null;
function closeChangedEditor() {
  if (opened && (opened.user !== window.PiRemotePerson.get() || opened.session !== window.PiRemotePerson.session())) { opened.popup.close(); opened = null; }
}
if (typeof window !== "undefined") {
  window.addEventListener("pi-auth", closeChangedEditor);
  window.addEventListener("pi-person", closeChangedEditor);
}
export function editorLaunch(value: unknown): { ok: true; value: EditorLaunch } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Invalid editor handoff" };
  const data = value as Record<string, unknown>;
  if (data.ok !== true || typeof data.url !== "string" || typeof data.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.ticket)) return { ok: false, error: "Invalid editor handoff" };
  try {
    const url = new URL(data.url);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/editor/open" || url.search || url.hash || url.username || url.password) return { ok: false, error: "Invalid editor origin" };
    return { ok: true, value: { url: url.href, ticket: data.ticket } };
  } catch { return { ok: false, error: "Invalid editor origin" }; }
}

export async function openPersonEditor(path: string | null, kind: "file" | "directory"): Promise<{ ok: true } | { ok: false; error: string }> {
  const identity = { user: window.PiRemotePerson.get(), session: window.PiRemotePerson.session() };
  const native = window.KenanRemote?.openEditor;
  const popup = native ? null : window.open("", "_blank");
  if (!native && !popup) return { ok: false, error: "Allow this site's popup to open your editor" };
  if (popup) { popup.opener = null; popup.document.title = "Opening editor"; popup.document.body.textContent = "Opening your editor…"; }
  try {
    const [config, environment] = await Promise.all([api("GET", API.editor.path()), window.KenanRemote?.getState()]);
    if (environment && config.environmentId !== environment.id) { popup?.close(); return { ok: false, error: "Open Files on the selected environment's own Pi Stack router to use its editor" }; }
    const parsed = editorLaunch(await api(API.editor.method, API.editor.path(), { path, kind }));
    if (!parsed.ok) { popup?.close(); return parsed; }
    if (identity.user !== window.PiRemotePerson.get() || identity.session !== window.PiRemotePerson.session()) { popup?.close(); return { ok: false, error: "Your session changed before the editor opened" }; }
    if (native) await native(parsed.value);
    else if (popup && !popup.closed) {
      const form = popup.document.createElement("form");
      form.method = "POST";
      form.action = parsed.value.url;
      const ticket = popup.document.createElement("input");
      ticket.type = "hidden";
      ticket.name = "ticket";
      ticket.value = parsed.value.ticket;
      form.append(ticket);
      popup.document.body.replaceChildren(form);
      opened?.popup.close();
      opened = { popup, ...identity };
      form.submit();
    } else return { ok: false, error: "The editor window was closed" };
    recordFeatureUsage("editor");
    return { ok: true };
  } catch (cause) { popup?.close(); return { ok: false, error: cause instanceof Error ? cause.message : "Could not open your editor" }; }
}
