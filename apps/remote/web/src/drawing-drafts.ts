export type DrawingBackground = {
  src: string;
  alt: string;
  name?: string;
  downloadSrc?: string;
  /** A canvas-safe copy of the decoded preview. The draft owns and closes it. */
  preview?: Promise<ImageBitmap | null>;
};
export type DrawingDraft = { id: string; chatId: string; background?: DrawingBackground };

export function findDrawingDraft(drafts: readonly DrawingDraft[], chatId: string, background?: DrawingBackground) {
  return drafts.find(draft => draft.chatId === chatId && draft.background?.src === background?.src);
}

export function drawingImage(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest("img, a");
  const image = element instanceof HTMLImageElement ? element : element?.querySelector("img");
  return image?.matches(".markdown-body img, .context-image") && image.getAttribute("src") ? image : null;
}
