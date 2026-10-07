import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, useSyncExternalStore } from "react";
import { API } from "../../../../server/api";
import { piFetch } from "../../client";
import { Markdown } from "../../context";
import { fileKind, type FileKind } from "./file-kind";
import { FileEditor, MAX_EDIT_BYTES } from "./file-editor";
import { fileDrafts, fileDraftScope } from "./file-editor-drafts";

const MAX_TEXT_BYTES = MAX_EDIT_BYTES;

export interface FilePreviewHandle {
  canLeave(): boolean;
}

type FileDetails = { size: number | null; contentType: string; kind: FileKind };

export interface FilePreviewProps {
  path: string | null;
  onAttach?(path: string): void;
}

function downloadPath(path: string, inline = false) {
  const link = API.fileDownload.path({}, inline ? { path, inline: 1 } : { path });
  return window.PiRemotePerson?.href(link) ?? link;
}

function fileName(path: string) {
  return path.split("/").filter(Boolean).at(-1) || path;
}

function formatSize(size: number | null) {
  if (size === null) return "Size unavailable";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function TextView({ source, truncated }: { source: string; truncated: boolean }) {
  const [wrap, setWrap] = useState(false);
  const lines = useMemo(() => source.split("\n"), [source]);
  return <section className="file-preview-text">
    <div className="file-preview-options"><button type="button" onClick={() => setWrap(value => !value)} aria-pressed={wrap}>{wrap ? "Disable wrap" : "Wrap lines"}</button></div>
    {truncated && <p className="file-preview-notice">Showing the first 1 MiB</p>}
    <pre className={wrap ? "wrap" : ""}>{lines.map((line, index) => <span className="file-preview-line" key={index}><span aria-hidden="true" className="file-preview-line-number">{index + 1}</span><code>{line || " "}</code>{"\n"}</span>)}</pre>
  </section>;
}

function MarkdownView({ source }: { source: string }) {
  return <Markdown source={source} sessionId="" className="markdown-body file-preview-markdown" />;
}

export const FilePreview = forwardRef<FilePreviewHandle, FilePreviewProps>(function FilePreview({ path, onAttach }, ref) {
  const [editor] = useState(() => new FileEditor());
  const editorState = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const activeEditor = editorState.path === path ? editorState : null;
  const editing = activeEditor?.phase === "editing" ? activeEditor : null;
  const dirty = !!editing && editing.draft !== editing.document.content;

  useEffect(() => {
    const scope = fileDraftScope();
    const person = window.PiRemotePerson.get();
    editor.activate(path, fileDrafts.take(scope, path));
    return () => {
      if (person === window.PiRemotePerson.get() && window.PiRemotePerson.session()) fileDrafts.keep(scope, editor.snapshot());
      editor.dispose();
    };
  }, [editor, path]);

  useImperativeHandle(ref, () => ({ canLeave() {
    const state = editor.snapshot();
    if (state.phase === "editing" && state.busy) {
      window.alert("Wait for the file operation to finish before leaving.");
      return false;
    }
    if (editor.dirty() && !window.confirm("Discard your unsaved file changes?")) return false;
    editor.cancel();
    return true;
  } }), [editor]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const [details, setDetails] = useState<FileDetails | null>(null);
  const [source, setSource] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState(false);
  const [naturalImage, setNaturalImage] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDetails(null);
    setSource("");
    setTruncated(false);
    setError(null);
    setSourceMode(false);
    setNaturalImage(false);
    if (!path) return () => controller.abort();
    const url = downloadPath(path);
    void (async () => {
      try {
        const response = await piFetch(url, { method: API.fileDownloadHead.method, signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Could not inspect file, HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        const sizeHeader = response.headers.get("content-length");
        const size = sizeHeader && Number.isFinite(Number(sizeHeader)) ? Number(sizeHeader) : null;
        const kind = fileKind(path, contentType);
        if (controller.signal.aborted) return;
        setDetails({ size, contentType, kind });
        if (kind !== "text" && kind !== "markdown") return;
        const text = await piFetch(url, { headers: { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` }, signal: controller.signal, cache: "no-store" });
        if (!text.ok) throw new Error(`Could not read file, HTTP ${text.status}`);
        const body = await text.text();
        if (!controller.signal.aborted) {
          setSource(body);
          setTruncated(text.status === 206 || (size !== null && size > MAX_TEXT_BYTES));
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load file");
      }
    })();
    return () => controller.abort();
  }, [path]);

  const documentSize = useMemo(() => activeEditor?.document ? new TextEncoder().encode(activeEditor.document.content).length : null, [activeEditor?.document]);

  if (!path) return <section className="file-preview-empty" aria-label="File preview">Select a file to preview it.</section>;
  const name = fileName(path);
  const kind = details?.kind;
  const visibleSource = activeEditor?.document?.content ?? source;
  const editable = (kind === "text" || kind === "markdown") && (details?.size === null || (details?.size ?? Infinity) <= MAX_EDIT_BYTES);
  return <section className="file-preview" aria-label={`Preview ${name}`}>
    <header className="file-preview-header">
      <div className="file-preview-title"><strong title={name}>{name}</strong><span>{details ? formatSize(documentSize ?? details.size) : error ? null : "Loading…"}</span></div>
      <div className="file-preview-actions">
        {editable && !editing && <button type="button" disabled={activeEditor?.phase === "loading"} onClick={() => void editor.begin()}>{activeEditor?.phase === "loading" ? "Opening editor…" : "Edit"}</button>}
        {editing && <>
          <button type="button" disabled={!dirty || !!editing.busy || !!editing.problem?.conflict} onClick={() => void editor.save()}>{editing.busy === "save" ? "Saving…" : "Save"}</button>
          <button type="button" disabled={!!editing.busy} onClick={() => { if (!dirty || window.confirm("Discard your unsaved file changes?")) editor.cancel(); }}>Cancel</button>
        </>}
        <a className="file-button" href={downloadPath(path)} download={name}>Download</a>
        <button type="button" onClick={() => void navigator.clipboard.writeText(path).catch(cause => setError(cause instanceof Error ? cause.message : "Could not copy path"))}>Copy path</button>
        {onAttach && <button type="button" onClick={() => onAttach(path)}>Attach</button>}
      </div>
    </header>
    {error && <div className="file-preview-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error">Dismiss</button></div>}
    {activeEditor?.problem && <div className="file-preview-error" role="alert"><span>{activeEditor.problem.conflict ? "This file changed on disk. Your draft is kept. Reload to use the latest version; reloading discards your draft. " : ""}{activeEditor.problem.error}</span></div>}
    {editing ? <section className="file-editor" aria-label="File editor">
      <div className="file-preview-options"><span role="status">{editing.busy === "reload" ? "Reloading…" : dirty ? "Unsaved changes" : "No changes"}</span><button type="button" disabled={!!editing.busy} onClick={() => { if (!dirty || window.confirm("Reload from disk and discard your unsaved changes?")) void editor.reload(); }}>Reload from disk</button></div>
      <textarea aria-label={`Edit ${name}`} autoFocus spellCheck={false} autoCapitalize="off" autoCorrect="off" value={editing.draft} disabled={!!editing.busy} onChange={event => editor.change(event.target.value)} />
    </section> : <>
      {kind === "markdown" && <><div className="file-preview-options"><button type="button" onClick={() => setSourceMode(value => !value)} aria-pressed={sourceMode}>{sourceMode ? "Show rendered" : "Show source"}</button></div>{sourceMode ? <TextView source={visibleSource} truncated={!activeEditor?.document && truncated} /> : <MarkdownView source={visibleSource} />}</>}
      {kind === "text" && <TextView source={visibleSource} truncated={!activeEditor?.document && truncated} />}
    </>}
    {kind === "image" && <div className={`file-preview-image${naturalImage ? " natural" : ""}`}><img src={downloadPath(path)} alt={name} onClick={() => setNaturalImage(value => !value)} title="Tap for natural size" /></div>}
    {kind === "audio" && <audio className="file-preview-audio" controls preload="metadata" src={downloadPath(path)} aria-label={name} />}
    {kind === "video" && <video className="file-preview-video" controls preload="metadata" playsInline src={downloadPath(path)} aria-label={name} />}
    {kind === "pdf" && <iframe className="file-preview-pdf" title={name} src={downloadPath(path, true)} />}
    {kind === "binary" && <p className="file-preview-binary">No preview is available for this file type.</p>}
  </section>;
});
