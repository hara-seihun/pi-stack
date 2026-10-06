export const REVEAL_VIRTUAL_MESSAGE = "reveal-virtual-message";

export function revealVirtualMessage(root: Element, id: string): boolean {
  const event = new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: id, cancelable: true });
  root.dispatchEvent(event);
  return event.defaultPrevented;
}
