export function isReadingEarlier(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight - scrollTop > 2;
}

export type ReadingSnapshot = {
  top: number;
  maxTop: number;
  anchor: Element | null;
  identity: { attribute: string; value: string } | null;
  anchorTop: number;
};

function capture(scroller: HTMLElement): ReadingSnapshot {
  const rect = scroller.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const anchorSelector = ".message, .work-card, .live-answer, .context-earlier";
  let visibleAnchor: Element | null = null;
  for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const candidate = scroller.ownerDocument.elementFromPoint(x, rect.top + rect.height * fraction)?.closest(anchorSelector);
    if (candidate && scroller.contains(candidate)) { visibleAnchor = candidate; break; }
  }
  const identified = visibleAnchor?.closest("[data-message-id], [data-transcript-seq], [data-virtual-key]");
  const attribute = identified && ["data-message-id", "data-transcript-seq", "data-virtual-key"].find(name => identified.hasAttribute(name));
  if (identified && scroller.contains(identified)) visibleAnchor = identified;
  return {
    top: scroller.scrollTop,
    maxTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    anchor: visibleAnchor,
    identity: attribute && identified ? { attribute, value: identified.getAttribute(attribute)! } : null,
    anchorTop: visibleAnchor?.getBoundingClientRect().top ?? 0,
  };
}

export function restoreReadingPosition(scroller: HTMLElement, before: ReadingSnapshot): ReadingSnapshot {
  const anchor = before.anchor && scroller.contains(before.anchor) ? before.anchor
    : before.identity ? [...scroller.querySelectorAll(`[${before.identity.attribute}]`)].find(node => node.getAttribute(before.identity!.attribute) === before.identity!.value) : null;
  if (anchor) {
    const delta = anchor.getBoundingClientRect().top - before.anchorTop;
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
  }
  // A removed anchor has no trustworthy geometry. Keep the current offset;
  // total-height compensation moves the reader when an unrelated row changes.
  return capture(scroller);
}

export class ReadingAnchor {
  private latest: ReadingSnapshot | null = null;
  private reading = false;
  private interacting = false;
  private writtenTop: number | null = null;

  setReading(scroller: HTMLElement, reading: boolean) {
    this.reading = reading;
    this.latest = capture(scroller);
  }

  beginInteraction(scroller: HTMLElement) {
    this.interacting = true;
    scroller.style.overflowAnchor = "auto";
    this.writtenTop = null;
    this.latest = capture(scroller);
  }

  endInteraction(scroller: HTMLElement) {
    this.interacting = false;
    scroller.style.overflowAnchor = "none";
    this.setReading(scroller, isReadingEarlier(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight));
    return this.reading;
  }

  onScroll(scroller: HTMLElement): { reading: boolean; programmatic: boolean } {
    if (this.writtenTop !== null && Math.abs(scroller.scrollTop - this.writtenTop) <= 0.5) {
      this.writtenTop = null;
      this.latest = capture(scroller);
      return { reading: this.reading, programmatic: true };
    }
    this.writtenTop = null;
    this.setReading(scroller, isReadingEarlier(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight));
    return { reading: this.reading, programmatic: false };
  }

  beforeUpdate(scroller: HTMLElement | null): ReadingSnapshot | null {
    return scroller ? capture(scroller) : null;
  }

  private apply(scroller: HTMLElement, before: ReadingSnapshot | null) {
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (before && before.maxTop > maxTop && before.top > maxTop && Math.abs(scroller.scrollTop - maxTop) <= 0.5) {
      this.writtenTop = scroller.scrollTop;
    }
    if (this.interacting || before && Math.abs(scroller.scrollTop - before.top) > 0.5) {
      this.latest = capture(scroller);
      return;
    }
    const top = scroller.scrollTop;
    if (this.reading) this.latest = before ? restoreReadingPosition(scroller, before) : capture(scroller);
    else {
      const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (Math.abs(bottom - top) > 0.5) scroller.scrollTop = bottom;
      this.latest = capture(scroller);
    }
    if (scroller.scrollTop !== top) this.writtenTop = scroller.scrollTop;
  }

  afterUpdate(scroller: HTMLElement | null, before: ReadingSnapshot | null) {
    if (scroller) this.apply(scroller, before);
  }

  afterResize(scroller: HTMLElement) {
    this.apply(scroller, this.latest);
  }

  pause(scroller: HTMLElement) {
    this.interacting = false;
    scroller.style.overflowAnchor = "none";
    this.latest = null;
    this.writtenTop = null;
  }

  jumpLatest(scroller: HTMLElement) {
    this.interacting = false;
    scroller.style.overflowAnchor = "none";
    this.setReading(scroller, false);
    this.apply(scroller, null);
  }
}
