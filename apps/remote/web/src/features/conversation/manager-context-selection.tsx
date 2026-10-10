import type { Session } from "../../types";

export function ManagerContextSelection({ selection }: { selection: Extract<Session["contextSelection"], { mode: "all" }> }) {
  return <details className="manager-context-selection" onClick={event => event.stopPropagation()}>
    <summary>All context · {selection.files.length} {selection.files.length === 1 ? "file" : "files"}</summary>
    <div className="manager-context-files"><strong>Selected automatically</strong><p>Every context file offered by this destination is selected. New files and edits are read on the next turn.</p>
      {selection.files.length ? <ul>{selection.files.map(file => <li key={file}>{file}</li>)}</ul> : <p>This destination offers no context files.</p>}
    </div>
  </details>;
}
