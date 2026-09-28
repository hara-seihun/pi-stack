import { createContext, useContext, useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { API } from "../../server/api";
import type { ClientCache, MediaLease } from "./client-cache";

export const ClientCacheContext = createContext<ClientCache | null>(null);

/** Only versioned or content-addressed media may outlive its source request. */
export function mediaCacheKey(src: string): string | null {
  const url = new URL(src, location.href);
  const start = url.pathname.lastIndexOf("/v1/");
  if (start < 0) return null;
  const path = url.pathname.slice(start);
  const avatar = API.messagingAvatar.match("GET", path);
  if (!(avatar && /^\d+$/.test(url.searchParams.get("v") ?? ""))
    && !API.messagingAttachment.match("GET", path)
    && !API.messagingPreviewImage.match("GET", path)
    && !API.sessionImage.match("GET", path)) return null;
  url.searchParams.delete("session");
  url.searchParams.delete("user");
  url.searchParams.delete("retry");
  url.searchParams.delete("download");
  return url.origin + url.pathname + url.search;
}

export function useCachedMedia(src: string | undefined, enabled = true, attempt = 0) {
  const cache = useContext(ClientCacheContext);
  const key = cache && src ? mediaCacheKey(src) : null;
  const [loaded, setLoaded] = useState<{ key: string; cache: ClientCache; url?: string; error?: string } | null>(null);
  const owned = loaded?.key === key && loaded?.cache === cache ? loaded : null;
  const available = key && cache ? cache.getMedia(key) || owned?.url : undefined;
  useEffect(() => {
    if (!enabled || !cache || !key || !src) return;
    let active = true;
    let lease: MediaLease | undefined;
    setLoaded(current => current?.key === key && current.cache === cache && !current.error ? current : null);
    void cache.acquireMedia(key, async signal => {
      const response = await fetch(src, { signal });
      if (!response.ok) throw new Error(`Could not load image: HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Media response is not an image");
      return blob;
    }).then(value => {
      if (!active) { value.release(); return; }
      lease = value;
      setLoaded({ key, cache, url: value.url });
    }, cause => { if (active) setLoaded({ key, cache, error: String(cause) }); });
    return () => { active = false; lease?.release(); };
  }, [cache, key, src, enabled, attempt]);
  if (!enabled || !src) return { src: undefined, ready: false, error: undefined };
  if (!cache || !key) return { src, ready: false, error: undefined };
  return { src: available || undefined, ready: !!available, error: owned?.error };
}

export function CachedImage({ src, fallback = null, onError, ...props }: ImgHTMLAttributes<HTMLImageElement> & { fallback?: ReactNode }) {
  const media = useCachedMedia(src);
  const [failed, setFailed] = useState<string>();
  if (media.error || failed === src || !media.src) return <>{fallback}</>;
  return <img {...props} src={media.src} data-source-url={src} onError={event => { setFailed(src); onError?.(event); }} />;
}
