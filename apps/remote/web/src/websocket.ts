/** Opens an authorized socket through the selected router or native environment. */
export function openWebSocket(path: string): WebSocket {
  const url = new URL(window.PiRemotePerson.href(path), location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}
