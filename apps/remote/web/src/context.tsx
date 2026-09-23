import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { InlineImage } from "../../server/inline-image-contract";
import { presentInlineImages, type ImagePresentation } from "./inline-images";
import { resourceUrl } from "./resource-url";
export { CopyButton } from "./chat-message";

export const InlineImagesContext = createContext<ReadonlyMap<string, InlineImage> | null>(null);
import { API } from "../../server/api";
import { applyHtml } from "./markdown-dom";
import { ensureMarkdown, markdownRenderer, normalizeLatex, onMarkdownReady, plainMarkdownHtml } from "./markdown-engine";
import { onKatexReady } from "./math-engine";
import { streamingMarkdown } from "./streaming-markdown";

// Neither the Markdown renderer nor KaTeX is in the page at startup: the first
// Markdown block downloads markdown-it, the first formula downloads KaTeX.
// Until each arrives the source shows as plain text, so every mounted block
// renders again when one of them is ready.
let renderGeneration = 0;
const renderListeners = new Set<() => void>();
const renderAgain = () => {
  renderGeneration += 1;
  for (const listener of renderListeners) listener();
};
onKatexReady(renderAgain);
onMarkdownReady(renderAgain);
const subscribeRender = (listener: () => void) => {
  renderListeners.add(listener);
  return () => { renderListeners.delete(listener); };
};
const renderSnapshot = () => renderGeneration;

const INLINE_IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function presentationMarkdown(source: string, sessionId: string) {
  return source.replace(/<pi-remote-file\s+src=["']([^"']+)["']\s*\/\s*>/gi, (_match, path) => {
    const name = String(path).split("/").filter(Boolean).at(-1) || "Download file";
    const label = name.replaceAll("&", "&amp;").replaceAll("[", "&#91;").replaceAll("]", "&#93;").replace(/[\r\n]+/g, " ");
    const link = API.sessionFiles.path({ sessionId }, { path });
    const href = resourceUrl(link);
    if (INLINE_IMAGE.test(name)) return `\n\n![${label}](${href})\n\n`;
    return `\n\n[${label}](${href})\n\n`;
  });
}

export function renderMarkdown(source: string, sessionId: string, streaming = false, presentation: ImagePresentation = {}) {
  const markdown = markdownRenderer();
  if (!markdown) return plainMarkdownHtml(source || "");
  const prepared = presentInlineImages(source || "", sessionId, { ...presentation, streaming });
  const normalized = normalizeLatex(presentationMarkdown(prepared.source, sessionId));
  return markdown.render(streaming ? streamingMarkdown(normalized) : normalized, { inlineImages: prepared.inlineImages });
}

export const Markdown = memo(function Markdown({ source, sessionId, streaming = false, assistant = false, className = "markdown-body" }: { source: string; sessionId: string; streaming?: boolean; assistant?: boolean; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const images = useContext(InlineImagesContext);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(() => new Set());
  const generation = useSyncExternalStore(subscribeRender, renderSnapshot, renderSnapshot);
  useEffect(() => { void ensureMarkdown().catch(console.error); }, []);
  const html = useMemo(() => renderMarkdown(source, sessionId, streaming, { assistant, images, failedUrls }), [source, sessionId, streaming, assistant, images, failedUrls, generation]);
  useLayoutEffect(() => { if (element.current) applyHtml(element.current, html); }, [html]);
  return <div ref={element} className={className} onErrorCapture={(event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.dataset.inlineImage) {
      const url = image.getAttribute("src");
      if (url) setFailedUrls(current => new Set([...current, url]));
    }
  }} />;
});

