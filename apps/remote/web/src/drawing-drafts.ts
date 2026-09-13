export type DrawingBackground = { src: string; alt: string };
export type DrawingDraft = { id: string; sessionId: string; background?: DrawingBackground };

export function findDrawingDraft(drafts: readonly DrawingDraft[], sessionId: string, background?: DrawingBackground) {
  return drafts.find(draft => draft.sessionId === sessionId && draft.background?.src === background?.src);
}

export function drawingImage(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest("img, a");
  const image = element instanceof HTMLImageElement ? element : element?.querySelector("img");
  return image?.matches(".markdown-body img, .context-image") && image.getAttribute("src") ? image : null;
}
