export type SignalPerson = { user: string; port: number };
export type SignalProxy = (person: SignalPerson, req: Request, url: URL) => Promise<Response>;

/** The local tool route selects one person's supervisor from the kernel UID. */
export async function handleAgentSignal(req: Request, peer: { uid: number } | undefined, people: ReadonlyMap<number, string>, person: (user: string) => SignalPerson | undefined, proxy: SignalProxy): Promise<Response> {
  const actor = peer && people.get(peer.uid);
  const owner = actor ? person(actor) : undefined;
  if (!owner) return Response.json({ error: "Signal tools require your own registered local Unix identity", code: "forbidden" }, { status: 403 });
  const url = new URL(req.url);
  return proxy(owner, req, url);
}

export function isSignalProductPath(path: string): boolean {
  return /^\/v1\/(?:agent-signal|messaging)(?:\/|$)/.test(path)
    || /^\/v1\/remotes\/[^/]+\/v1\/(?:agent-signal|messaging)(?:\/|$)/.test(path);
}
