// Assigning innerHTML on every streamed chunk throws away the whole rendered
// message and builds it again: images blink, KaTeX re-lays out, and a text
// selection is lost. Patching the existing nodes instead leaves everything the
// reader is already looking at untouched and only touches what actually
// changed, which is nearly always the last paragraph.

function sameShape(current: Node, next: Node) {
  return current.nodeType === next.nodeType && current.nodeName === next.nodeName;
}

function syncAttributes(current: Element, next: Element) {
  for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
}

function morph(current: Node, next: Node) {
  if (current.isEqualNode(next)) return;
  if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  syncAttributes(current as Element, next as Element);
  morphChildren(current, next);
}

function morphChildren(current: Node, next: Node) {
  const incoming = [...next.childNodes];
  for (const [index, candidate] of incoming.entries()) {
    const existing = current.childNodes[index];
    if (!existing) current.appendChild(candidate);
    else if (sameShape(existing, candidate)) morph(existing, candidate);
    else current.replaceChild(candidate, existing);
  }
  while (current.childNodes.length > incoming.length) current.removeChild(current.lastChild as Node);
}

const rendered = new WeakMap<HTMLElement, string>();

/** Bring `container` in line with `html` while keeping every node that is already correct. */
export function applyHtml(container: HTMLElement, html: string) {
  if (rendered.get(container) === html) return;
  const parsed = container.ownerDocument.createElement("div");
  parsed.innerHTML = html;
  morphChildren(container, parsed);
  rendered.set(container, html);
}
