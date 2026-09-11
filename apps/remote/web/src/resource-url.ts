export function resourceUrl(path: string): string {
  const identified = window.PiRemotePerson?.href(path) ?? path;
  return window.KenanRemote?.resolveApiUrl(identified) ?? identified;
}
