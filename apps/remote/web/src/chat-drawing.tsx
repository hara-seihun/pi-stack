import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DrawingAttachmentResult } from "./DrawingCanvas";
import { findDrawingDraft, type DrawingBackground, type DrawingDraft } from "./drawing-drafts";

// The canvas, its colour picker and the paper geometry are a drawing
// application inside the chat, and a chat opens far more often than the
// paintbrush is pressed. The module arrives with the first draft.
const DrawingCanvas = lazy(() => import("./DrawingCanvas").then(module => ({ default: module.DrawingCanvas })));
const closedPreviews = new WeakSet<ImageBitmap>();

function decodedPreview(image: HTMLImageElement) {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || typeof window.createImageBitmap !== "function") return undefined;
  try {
    const sameOrigin = new URL(image.currentSrc || image.src, window.location.href).origin === window.location.origin;
    if (!sameOrigin && image.crossOrigin !== "anonymous") return undefined;
    return window.createImageBitmap(image).catch(() => null);
  } catch {
    return undefined;
  }
}

function imageName(image: HTMLImageElement) {
  const src = image.currentSrc || image.src;
  const dataType = /^data:image\/([^;,]+)/i.exec(src)?.[1].toLowerCase();
  if (dataType) return `image.${dataType === "jpeg" ? "jpg" : dataType === "svg+xml" ? "svg" : dataType}`;
  try {
    const url = new URL(src, window.location.href);
    const path = url.searchParams.get("path") || decodeURIComponent(url.pathname);
    const name = path.split("/").filter(Boolean).at(-1) || "";
    return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name) ? name : image.alt.trim() || name || "image";
  } catch {
    return image.alt.trim() || "image";
  }
}

function imageDownloadSrc(image: HTMLImageElement, src: string) {
  if (image.dataset.downloadQuery !== "true") return src;
  try {
    const url = new URL(src, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return src;
    url.searchParams.set("download", "1");
    return url.href;
  } catch {
    return src;
  }
}

function closePreview(background?: DrawingBackground) {
  void background?.preview?.then(preview => {
    if (!preview || closedPreviews.has(preview)) return;
    closedPreviews.add(preview);
    preview.close();
  });
}

export function useChatDrawing(chatId: string | null, attach: (file: File, chatId: string) => Promise<DrawingAttachmentResult>) {
  const [drafts, setDrafts] = useState<DrawingDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const opener = useRef<{ chatId: string; element: HTMLElement } | null>(null);
  const draftsRef = useRef(drafts);
  const wasOpen = useRef(false);
  draftsRef.current = drafts;
  useEffect(() => () => { for (const draft of draftsRef.current) closePreview(draft.background); }, []);
  const slots = useRef(new Map<string, HTMLDivElement>());
  const isOpen = drafts.some(draft => draft.id === selectedId && draft.chatId === chatId);
  useLayoutEffect(() => {
    if (isOpen && selectedId) slots.current.get(selectedId)?.querySelector<HTMLButtonElement>('button[aria-label="Cancel drawing"]')?.focus({ preventScroll: true });
    else if (wasOpen.current) {
      if (opener.current?.chatId === chatId && opener.current.element.isConnected) opener.current.element.focus({ preventScroll: true });
      opener.current = null;
    }
    wasOpen.current = isOpen;
  }, [isOpen, selectedId, chatId]);
  const open = (background?: DrawingBackground) => {
    if (!chatId) return;
    const draft = findDrawingDraft(drafts, chatId, background) ?? { id: crypto.randomUUID(), chatId, background };
    setDrafts(current => current.some(item => item.id === draft.id) ? current : [...current, draft]);
    if (document.activeElement instanceof HTMLElement) opener.current = { chatId, element: document.activeElement };
    setSelectedId(draft.id);
  };
  const editImage = (image: HTMLImageElement) => {
    image.focus({ preventScroll: true });
    const src = image.currentSrc || image.src;
    const existing = chatId ? findDrawingDraft(drafts, chatId, { src, alt: image.alt }) : undefined;
    if (existing) {
      open(existing.background);
      return;
    }
    open({ src, alt: image.alt, name: imageName(image), downloadSrc: imageDownloadSrc(image, src), preview: decodedPreview(image) });
  };
  const editors = drafts.map(draft => {
    const active = isOpen && selectedId === draft.id;
    return <div key={draft.id} ref={element => { if (element) slots.current.set(draft.id, element); else slots.current.delete(draft.id); }} className="drawing-slot" hidden={!active}>
      <Suspense fallback={<p className="muted" role="status">Opening the drawing tools…</p>}><DrawingCanvas active={active} background={draft.background} onAttach={async file => {
        const result = await attach(file, draft.chatId);
        if (result.ok) {
          closePreview(draft.background);
          setDrafts(current => current.filter(item => item.id !== draft.id));
          setSelectedId(current => current === draft.id ? null : current);
        }
        return result;
      }} onClose={() => setSelectedId(current => current === draft.id ? null : current)} /></Suspense>
    </div>;
  });
  return { isOpen, open, editImage, editors };
}

export type ChatDrawing = ReturnType<typeof useChatDrawing>;
