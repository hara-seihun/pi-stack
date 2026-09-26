import { useEffect, useState } from "react";
import { useNearViewport } from "./near-viewport";
import type { MessagingLinkPreview } from "../../server/messaging/protocol";
import { messagingClient } from "./messaging-client";
import { resourceUrl } from "./resource-url";
import "./link-previews.css";

export function LinkPreviewCard({ preview }: { preview: MessagingLinkPreview }) {
  const { ref, near } = useNearViewport<HTMLAnchorElement>();
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const image = preview.imageUrl;
  useEffect(() => setImageState("loading"), [image]);
  const imageSrc = image && (image.startsWith("/") ? resourceUrl(image) : image);
  return <a className="link-preview" href={preview.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" ref={ref}>
    {image && <span className="link-preview-artwork">
      {imageState === "loading" && <span className="link-preview-image-placeholder" aria-hidden="true" />}
      {near && imageState !== "error" && <img className="link-preview-image" src={imageSrc || undefined} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setImageState("ready")} onError={() => setImageState("error")} />}
      {imageState === "error" && <span className="link-preview-image-error">Image unavailable</span>}
    </span>}
    <span className="link-preview-copy">
      <span className="link-preview-site">{preview.siteName || new URL(preview.url).hostname}</span>
      <span className="link-preview-title">{preview.title || preview.url}</span>
      {preview.description && <span className="link-preview-description">{preview.description}</span>}
    </span>
  </a>;
}

type PreviewState = { status: "loading" } | { status: "ready"; previews: MessagingLinkPreview[] } | { status: "failed" };

export function MessageLinkPreviews({ messageId }: { messageId: string }) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  useEffect(() => {
    if (!near) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    void messagingClient.linkPreviews(messageId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: "ready", previews: result.value.previews } : { status: "failed" });
    });
    return () => controller.abort();
  }, [messageId, attempt, near]);
  return <div className="message-link-previews" ref={ref}>
    {state.status === "loading" && <div className="link-preview-skeleton" aria-label="Loading link preview"><span /><span /><span /></div>}
    {state.status === "ready" && state.previews.map(preview => <LinkPreviewCard key={preview.url} preview={preview} />)}
    {state.status === "failed" && <button type="button" className="link-preview-retry" onClick={() => setAttempt(value => value + 1)}>Retry link preview</button>}
  </div>;
}
