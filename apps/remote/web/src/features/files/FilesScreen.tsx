import { useEffect, useState } from "react";
import { API } from "../../../../server/api";
import type { FileBrowserEntry } from "../../../../server/protocol";
import { api } from "../../client";
import { openPersonEditor } from "./editor-launch";
import "./files.css";

export interface FilesScreenProps {
  layout: "stack" | "split";
  selectedPath: string | null;
  onSelect(path: string | null): void;
  shortcuts: { label: string; path: string }[];
  onAttach?(path: string): void;
}
type Selection = { kind: "unset" } | { kind: "loading"; path: string } | { kind: "ready"; entry: FileBrowserEntry } | { kind: "error"; error: string };

export function FilesScreen({ selectedPath, onSelect, shortcuts, onAttach }: FilesScreenProps) {
  const [path, setPath] = useState(selectedPath ?? "");
  const [selection, setSelection] = useState<Selection>({ kind: "unset" });
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPath(selectedPath ?? "");
    if (!selectedPath) { setSelection({ kind: "unset" }); return; }
    let active = true;
    setSelection({ kind: "loading", path: selectedPath });
    void api(API.fileInfo.method, API.fileInfo.path({}, { path: selectedPath })).then(({ entry }: { entry: FileBrowserEntry }) => {
      if (active) setSelection({ kind: "ready", entry });
    }).catch((cause: unknown) => { if (active) setSelection({ kind: "error", error: cause instanceof Error ? cause.message : "Could not inspect the path" }); });
    return () => { active = false; };
  }, [selectedPath]);

  async function open(target: string | null, kind: "file" | "directory") {
    setOpening(true);
    setError(null);
    const result = await openPersonEditor(target, kind);
    setOpening(false);
    if (!result.ok) setError(result.error);
  }
  const entry = selection.kind === "ready" ? selection.entry : null;
  const places = [...new Map(shortcuts.map(shortcut => [shortcut.path, shortcut])).values()];
  return <section className="files-screen" aria-label="Files">
    <h2>Files</h2>
    <p>Browse and edit your workspace in VS Code.</p>
    <button type="button" disabled={opening} onClick={() => void open(null, "directory")}>{opening ? "Opening…" : "Open VS Code"}</button>
    {places.length > 0 && <nav className="files-shortcuts" aria-label="Workspaces">{places.map(place => <button type="button" key={place.path} disabled={opening} onClick={() => void open(place.path, "directory")}>{place.label}</button>)}</nav>}
    <form className="files-selection" onSubmit={event => { event.preventDefault(); setError(null); if (!path.startsWith("/")) { setError("Enter an absolute path"); return; } onSelect(path); }}>
      <label>Attach or open an exact path<input value={path} placeholder="/absolute/path" onChange={event => setPath(event.target.value)} /></label>
      <button type="submit">Choose path</button>
      {selectedPath && <button type="button" onClick={() => onSelect(null)}>Clear</button>}
    </form>
    {selection.kind === "loading" && <p role="status">Inspecting {selection.path}…</p>}
    {entry && <div className="files-actions"><code>{entry.path}</code>
      {entry.kind !== "other" && <button type="button" disabled={opening} onClick={() => void open(entry.path, entry.kind as "file" | "directory")}>Open in VS Code</button>}
      {entry.kind === "file" && onAttach && <button type="button" onClick={() => onAttach(entry.path)}>Attach to current chat</button>}
      {entry.kind === "other" && <p>This path is not a regular file or folder.</p>}
    </div>}
    {(error || selection.kind === "error") && <p role="alert">{error ?? (selection.kind === "error" ? selection.error : "")}</p>}
  </section>;
}
