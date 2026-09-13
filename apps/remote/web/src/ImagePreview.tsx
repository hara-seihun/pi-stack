import { useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import "./image-preview.css";

type Preview = { src: string; alt: string };

function ImagePreview({ image, opener, onClose }: { image: Preview; opener: HTMLElement | null; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      opener?.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialog} className="image-preview" aria-label="Image preview" onCancel={onClose}>
    <TransformWrapper minScale={1} maxScale={8} centerOnInit centerZoomedOut wheel={{ step: 0.15 }}>
      <TransformComponent wrapperClass="image-preview-viewport" contentClass="image-preview-content">
        <img src={image.src} alt={image.alt} draggable={false} />
      </TransformComponent>
    </TransformWrapper>
    <button type="button" className="image-preview-close" aria-label="Close image preview" autoFocus onClick={onClose}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
  </dialog>;
}

export function ImagePreviewScope({ children }: { children: ReactNode }) {
  const [image, setImage] = useState<Preview | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  function open(event: SyntheticEvent) {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest("img, a");
    const candidate = target instanceof HTMLImageElement ? target : target?.querySelector("img");
    if (!candidate?.matches(".markdown-body img, .context-image") || !candidate.getAttribute("src")) return;
    event.preventDefault();
    event.stopPropagation();
    opener.current = target instanceof HTMLElement ? target : candidate;
    setImage({ src: candidate.currentSrc || candidate.src, alt: candidate.alt });
  }
  function close() {
    setImage(null);
  }
  return <div className="image-preview-scope" onClickCapture={open} onKeyDownCapture={event => {
    if (event.key === "Enter" || event.key === " ") open(event);
  }}>
    {children}
    {image && <ImagePreview image={image} opener={opener.current} onClose={close} />}
  </div>;
}
