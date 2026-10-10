import type { Person } from "./persons";

const STRIPPED = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailer", "cookie", "authorization", "forwarded", "referer", "host"]);
export function editorHeaders(req: Request, person: Person): Headers {
  const headers = new Headers(req.headers);
  for (const key of (headers.get("connection") ?? "").split(",")) if (key.trim()) headers.delete(key.trim());
  for (const key of [...headers.keys()]) if (STRIPPED.has(key) || key.startsWith("x-pi-remote-") || key.startsWith("x-forwarded-") || key.startsWith("cf-access-")) headers.delete(key);
  headers.set("host", new URL(person.editor!.origin).host);
  headers.set("x-forwarded-proto", new URL(person.editor!.origin).protocol.slice(0, -1));
  return headers;
}

export function editorFrameHeaders(headers: Headers, parentOrigin: string): void {
  const parent = new URL(parentOrigin);
  if (!["http:", "https:"].includes(parent.protocol) || parent.origin !== parentOrigin) throw new Error("Editor grant contains an invalid parent origin");
  headers.delete("x-frame-options");
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    const policy = headers.get(name);
    if (policy === null && name.endsWith("report-only")) continue;
    const policies = policy === null ? [""] : policy.split(",");
    headers.set(name, policies.map(value => [
      ...value.split(";").map(directive => directive.trim()).filter(directive => directive && directive.split(/\s/, 1)[0]!.toLowerCase() !== "frame-ancestors"),
      `frame-ancestors 'self' ${parentOrigin}`,
    ].join("; ")).join(", "));
  }
}

export async function editorResponse(person: Person, req: Request, url: URL, signal: AbortSignal, socket: string, parentOrigin: string): Promise<Response> {
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;
    const response = await fetch(`http://localhost${url.pathname}${url.search}`, {
      unix: socket, decompress: false, method: req.method, headers: editorHeaders(req, person), body,
      redirect: "manual", signal: AbortSignal.any([signal, req.signal]), ...(body ? { duplex: "half" } : {}),
    });
    const headers = new Headers(response.headers);
    editorFrameHeaders(headers, parentOrigin);
    for (const key of STRIPPED) if (key !== "host" && key !== "referer") headers.delete(key);
    headers.delete("set-cookie");
    headers.set("cache-control", "no-store");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json({ error: signal.aborted ? "Editor session ended" : "Editor unavailable", code: signal.aborted ? "editor_session_ended" : "editor_unavailable" }, { status: signal.aborted ? 423 : 503, headers: { "cache-control": "no-store" } });
  }
}
