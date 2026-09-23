import { useEffect, useRef, useState } from "react";
import type { MessagingLinkPreview } from "../../server/messaging/protocol";
import { messagingClient } from "./messaging-client";
import { resourceUrl } from "./resource-url";
import "./link-previews.css";

export function LinkPreviewCard({ preview }: { preview: MessagingLinkPreview }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = preview.imageUrl;
  return <a className="link-preview" href={preview.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
    {image && failedImage !== image && <img className="link-preview-image" src={image.startsWith("/") ? resourceUrl(image) : image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedImage(image)} />}
    <span className="link-preview-copy">
      <span className="link-preview-site">{preview.siteName || new URL(preview.url).hostname}</span>
      <span className="link-preview-title">{preview.title || preview.url}</span>
      {preview.description && <span className="link-preview-description">{preview.description}</span>}
    </span>
  </a>;
}

type PreviewState = { status: "loading" } | { status: "ready"; previews: MessagingLinkPreview[] } | { status: "failed" };

export function MessageLinkPreviews({ messageId }: { messageId: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    setState({ status: "loading" });
    const load = async () => {
      if (started) return;
      started = true;
      const result = await messagingClient.linkPreviews(messageId, controller.signal);
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: "ready", previews: result.value.previews } : { status: "failed" });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer?.disconnect();
        void load();
      }
    }, { rootMargin: "200px" });
    if (observer && element.current) observer.observe(element.current);
    else void load();
    return () => { observer?.disconnect(); controller.abort(); };
  }, [messageId, attempt]);
  return <div className="message-link-previews" ref={element}>
    {state.status === "ready" && state.previews.map(preview => <LinkPreviewCard key={preview.url} preview={preview} />)}
    {state.status === "failed" && <button type="button" className="link-preview-retry" onClick={() => setAttempt(value => value + 1)}>Retry link preview</button>}
  </div>;
}
