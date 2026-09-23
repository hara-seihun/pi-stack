/** An API path an `<img>` or `<a>` can fetch: carries the person's identity and, in the app shell, the router origin. */
export function resourceUrl(path: string): string {
  if (typeof window === "undefined") return path;
  const identified = window.PiRemotePerson?.href(path) ?? path;
  return window.KenanRemote?.resolveApiUrl(identified) ?? identified;
}
