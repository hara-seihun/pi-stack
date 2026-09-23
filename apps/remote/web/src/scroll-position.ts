export function isReadingEarlier(scrollTop: number): boolean {
  return scrollTop < -2;
}

export type ReadingSnapshot = {
  top: number;
  height: number;
  anchor: Element | null;
  anchorTop: number;
};

function capture(scroller: HTMLElement): ReadingSnapshot {
  const rect = scroller.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const anchorSelector = ".message, .work-card, .live-answer, .context-earlier";
  let visibleAnchor: Element | null = null;
  for (const fraction of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const candidate = scroller.ownerDocument.elementFromPoint(x, rect.top + rect.height * fraction)?.closest(anchorSelector);
    if (candidate && scroller.contains(candidate)) { visibleAnchor = candidate; break; }
  }
  if (!visibleAnchor) {
    const candidate = scroller.ownerDocument.elementFromPoint(x, rect.top + rect.height / 2)?.closest(".transcript");
    if (candidate && scroller.contains(candidate)) visibleAnchor = candidate;
  }
  return {
    top: scroller.scrollTop,
    height: scroller.scrollHeight,
    anchor: visibleAnchor,
    anchorTop: visibleAnchor?.getBoundingClientRect().top ?? 0,
  };
}

export function restoreReadingPosition(scroller: HTMLElement, before: ReadingSnapshot): ReadingSnapshot {
  const anchor = before.anchor;
  if (anchor && scroller.contains(anchor)) {
    scroller.scrollTop += anchor.getBoundingClientRect().top - before.anchorTop;
  } else {
    // Completion can replace the live message itself, leaving no surviving anchor.
    scroller.scrollTop = before.top - (scroller.scrollHeight - before.height);
  }
  return capture(scroller);
}

export class ReadingAnchor {
  readonly needsFallback = !(typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto"));
  private latest: ReadingSnapshot | null = null;
  private reading = false;

  setReading(scroller: HTMLElement, reading: boolean) {
    this.reading = reading;
    this.latest = this.needsFallback && reading ? capture(scroller) : null;
  }

  beforeUpdate(scroller: HTMLElement | null): ReadingSnapshot | null {
    return this.needsFallback && this.reading && scroller ? capture(scroller) : null;
  }

  afterUpdate(scroller: HTMLElement | null, before: ReadingSnapshot | null) {
    if (!scroller || !this.reading || !this.needsFallback) return;
    this.latest = before ? restoreReadingPosition(scroller, before) : capture(scroller);
  }

  afterResize(scroller: HTMLElement) {
    if (!this.reading || !this.needsFallback || !this.latest) return;
    this.latest = restoreReadingPosition(scroller, this.latest);
  }
}
