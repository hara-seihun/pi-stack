import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilesScreen } from "../../src/features/files/FilesScreen";

const documents = new Map([
  ["/fixture.txt", { content: "Initial text\n", revision: "1" }],
  ["/fixture.md", { content: "# Initial markdown\n", revision: "1" }],
]);
let acceptDiscard = false;
let failSave = false;
window.PiRemotePerson = { get: () => "fixture-person", href: (path: string) => path, session: () => "fixture-only" } as typeof window.PiRemotePerson;
window.confirm = () => { const accepted = acceptDiscard; acceptDiscard = false; return accepted; };
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), window.location.href);
  const path = url.searchParams.get("path") || "";
  const document = documents.get(path);
  if (url.pathname === "/v1/files") return Response.json({ directory: { entries: [...documents.keys()].map(path => ({ path, name: path.slice(1), kind: "file" })) } });
  if (url.pathname === "/v1/files/info") return Response.json({ entry: { path, name: path.slice(1), kind: "file" } });
  if (url.pathname === "/v1/files/download" && document) return new Response(init?.method === "HEAD" ? null : document.content, { headers: { "content-type": path.endsWith(".md") ? "text/markdown" : "text/plain", "content-length": String(new TextEncoder().encode(document.content).length) } });
  if (url.pathname === "/v1/files/edit") {
    if (init?.method !== "PUT") return document ? Response.json({ path, ...document }) : Response.json({ error: "Fixture not found" }, { status: 404 });
    const body = JSON.parse(String(init.body));
    const current = documents.get(body.path);
    if (failSave) return Response.json({ error: "Fixture disk full" }, { status: 500 });
    if (!current || current.revision !== body.revision) return Response.json({ error: "Fixture revision changed" }, { status: 409 });
    const saved = { content: body.content, revision: String(Number(current.revision) + 1) };
    documents.set(body.path, saved);
    return Response.json({ path: body.path, ...saved });
  }
  return Response.json({ error: "Only disposable fixture requests are allowed" }, { status: 404 });
}) as typeof fetch;

function Fixture() {
  const [path, setPath] = useState<string | null>("/fixture.txt");
  const [visible, setVisible] = useState(true);
  const [, refresh] = useState(0);
  return <>
    <div style={{ display: "flex", gap: 12, padding: 12 }}>
      <button onClick={() => { const current = documents.get(path!); if (current) documents.set(path!, { content: "External change\n", revision: String(Number(current.revision) + 1) }); }}>External change</button>
      <button onClick={() => { acceptDiscard = false; refresh(value => value + 1); }}>Reject discard</button>
      <button onClick={() => { acceptDiscard = true; refresh(value => value + 1); }}>Accept discard</button>
      <button onClick={() => { failSave = !failSave; refresh(value => value + 1); }}>{failSave ? "Allow saves" : "Fail saves"}</button>
      <button onClick={() => { setVisible(value => !value); if (visible) setPath(null); }}>{visible ? "Leave Files tab" : "Return to Files tab"}</button>
      <output aria-label="Selected fixture path">{path}</output>
    </div>
    {visible && <div style={{ height: "85vh" }}><FilesScreen layout="split" selectedPath={path} onSelect={setPath} shortcuts={[]} /></div>}
  </>;
}

const style = document.createElement("style");
style.textContent = ":root{--bg:#fff;--text:#202020;--muted:#666;--surface:#eee;--surface-2:#ddd;--border:#aaa;--accent:#177ba5;--danger:#b00;--warning:#960;--touch:44px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--radius-2:6px;--text-sm:14px;--font-mono:monospace}body{font-family:sans-serif;margin:0}";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Fixture />);
