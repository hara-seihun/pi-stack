import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "../../../../server/api";
import type { FileBrowserEntry } from "../../../../server/protocol";
import { api } from "../../client";
import { breadcrumbSegments, cleanAbsolutePath, parentDirectory, rootShortcuts, routePath, type FileSelection, type FileSelectionKind, type FileShortcut } from "./file-navigation";
import { FilePreview } from "./FilePreview";
import { FileTree, type FileTreeHandle } from "./FileTree";
import "./files.css";

export interface FilesScreenProps {
  layout: "stack" | "split";
  selectedPath: string | null;
  onSelect(path: string | null): void;
  shortcuts: FileShortcut[];
  onAttach?(path: string): void;
  onRootCount?(count: number): void;
}

function RefreshIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9A7 7 0 0 1 18.8 7.7L20 11M4 13l1.2 3.3A7 7 0 0 0 17.9 15" /></svg>;
}

export function FilesScreen({ layout, selectedPath, onSelect, shortcuts, onAttach, onRootCount }: FilesScreenProps) {
  const initialPath = selectedPath ? cleanAbsolutePath(selectedPath) : "/";
  const [selection, setSelection] = useState<FileSelection>({ path: initialPath, kind: initialPath === "/" ? "directory" : "resolving" });
  const [goTo, setGoTo] = useState("");
  const [goToOpen, setGoToOpen] = useState(false);
  const [goToError, setGoToError] = useState<string | null>(null);
  const tree = useRef<FileTreeHandle>(null);
  const pendingPath = useRef<string | null>(null);
  const knownKinds = useRef(new Map<string, FileSelectionKind>([["/", "directory"]]));

  const resolveSelection = useCallback((path: string) => {
    const clean = cleanAbsolutePath(path);
    const known = knownKinds.current.get(clean);
    if (known) {
      pendingPath.current = null;
      setSelection({ path: clean, kind: known });
      return;
    }
    if (pendingPath.current === clean) return;
    pendingPath.current = clean;
    setSelection({ path: clean, kind: "resolving" });
    void api(API.fileInfo.method, API.fileInfo.path({}, { path: clean })).then(({ entry }: { entry: FileBrowserEntry }) => {
      if (pendingPath.current !== clean) return;
      if (entry.kind !== "directory" && entry.kind !== "file") throw new Error("This path is not a regular file or folder.");
      knownKinds.current.set(clean, entry.kind);
      pendingPath.current = null;
      setSelection({ path: clean, kind: entry.kind });
    }).catch((cause: unknown) => {
      if (pendingPath.current !== clean) return;
      pendingPath.current = null;
      setGoTo(clean);
      setGoToOpen(true);
      setGoToError(cause instanceof Error ? cause.message : "Could not inspect this path.");
    });
  }, []);

  useEffect(() => {
    resolveSelection(selectedPath ? cleanAbsolutePath(selectedPath) : "/");
    return () => { pendingPath.current = null; };
  }, [resolveSelection, selectedPath]);

  const selectEntry = (path: string, kind: FileSelectionKind) => {
    const clean = cleanAbsolutePath(path);
    pendingPath.current = null;
    knownKinds.current.set(clean, kind);
    setSelection({ path: clean, kind });
    onSelect(routePath(clean));
  };

  const navigate = (path: string) => {
    const clean = cleanAbsolutePath(path);
    if (!clean.startsWith("/")) {
      setGoToError("Enter an absolute path.");
      return;
    }
    setGoToError(null);
    setGoToOpen(false);
    setGoTo("");
    knownKinds.current.delete(clean);
    onSelect(routePath(clean));
    if (clean === (selectedPath ? cleanAbsolutePath(selectedPath) : "/")) resolveSelection(clean);
  };

  const fileSelected = selection.kind === "file";
  const previewOpen = layout === "stack" && fileSelected;
  const currentDirectory = fileSelected ? parentDirectory(selection.path) : selection.path;
  const segments = breadcrumbSegments(currentDirectory);
  const visibleShortcuts = currentDirectory === "/" && !fileSelected ? rootShortcuts(shortcuts, currentDirectory) : [];

  return <section className={`files-screen ${layout}${previewOpen ? " preview-open" : ""}`} aria-label="Files">
    <header className="files-pathbar">
      {previewOpen && <button type="button" className="files-back" onClick={() => selectEntry(currentDirectory, "directory")}>Back</button>}
      <nav className="files-breadcrumbs" aria-label="Current folder">
        {segments.map((segment, index) => index === segments.length - 1
          ? <span className="files-breadcrumb-current" key={segment.path} aria-current="page">{segment.label}</span>
          : <button type="button" key={segment.path} onClick={() => selectEntry(segment.path, "directory")}>{segment.label}</button>)}
      </nav>
      <button type="button" className="files-icon-button" onClick={() => void tree.current?.refresh()} aria-label={`Refresh ${currentDirectory}`} title="Refresh"><RefreshIcon /></button>
      <button type="button" className="files-go-button" onClick={() => { setGoToOpen(value => !value); setGoToError(null); }} aria-expanded={goToOpen} aria-controls="files-location-form">{goToOpen ? "Cancel" : "Go to"}</button>
    </header>
    {goToOpen && <form id="files-location-form" className="files-goto" onSubmit={event => { event.preventDefault(); navigate(goTo); }}><label>Path <input autoFocus value={goTo} onChange={event => setGoTo(event.target.value)} placeholder="/absolute/path" /></label><button type="submit">Open</button>{goToError && <span role="alert">{goToError}</span>}</form>}
    {visibleShortcuts.length > 0 && <nav className="files-shortcuts" aria-label="Places">{visibleShortcuts.map(shortcut => <button type="button" key={shortcut.path} onClick={() => selectEntry(shortcut.path, "directory")}>{shortcut.label}</button>)}</nav>}
    <div className="files-content">
      <aside className="files-tree-pane" aria-label="File tree"><FileTree ref={tree} selectedPath={selection.kind === "resolving" ? null : selection.path} onSelect={selectEntry} onRootCount={onRootCount} /></aside>
      <main className="files-preview-pane"><FilePreview path={fileSelected ? selection.path : null} onAttach={onAttach} /></main>
    </div>
  </section>;
}
