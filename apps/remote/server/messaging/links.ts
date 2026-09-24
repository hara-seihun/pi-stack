import type { MessagingLinkPreview } from "./protocol";

/** Shared with the browser: only literal HTTP(S) links in message text get cards. */
export function extractMessageLinks(text: string, limit = 3): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let candidate = match[0].replace(/[.,!?;:]+$/, "");
    while (candidate.endsWith(")") && (candidate.match(/\)/g)?.length ?? 0) > (candidate.match(/\(/g)?.length ?? 0)) candidate = candidate.slice(0, -1);
    while (candidate.endsWith("]") && (candidate.match(/\]/g)?.length ?? 0) > (candidate.match(/\[/g)?.length ?? 0)) candidate = candidate.slice(0, -1);
    try {
      const url = new URL(candidate);
      if (!url.hostname || !/^https?:$/.test(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href);
      links.push(url.href);
      if (links.length === limit) break;
    } catch { /* Invalid text is not a link. */ }
  }
  return links;
}

export function simpleLinkPreview(url: string): MessagingLinkPreview {
  return { url, title: new URL(url).hostname, description: null, imageUrl: null, siteName: null };
}
