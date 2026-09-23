import { API } from "../../server/api";
import { parseInlineImageTags, type InlineImage, type InlineImageTag } from "../../server/inline-image-contract";
import { resourceUrl } from "./resource-url";

export interface ImagePresentation {
  assistant?: boolean;
  streaming?: boolean;
  images?: ReadonlyMap<string, InlineImage> | null;
  failedUrls?: ReadonlySet<string>;
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function imageHtml(tag: InlineImageTag, sessionId: string, presentation: ImagePresentation): string {
  const image = tag.partial ? undefined : presentation.images?.get(tag.id);
  const error = tag.error || image?.error?.message;
  const warning = image?.conflict ? `<span class="inline-image-error" role="alert">${escape(image.conflict)}</span>` : "";
  const label = escape(tag.id || "Image");
  const shell = (body: string) => `<span class="inline-image" data-image-id="${label}">${body}<span class="inline-image-label">${label}</span>${warning}</span>`;
  if (error) return shell(`<span class="inline-image-placeholder inline-image-error" role="alert"><strong>Image failed</strong><span>${escape(error)}</span></span>`);
  if (image?.state === "complete" && image.path) {
    const href = resourceUrl(API.sessionFiles.path({ sessionId }, { path: image.path }));
    const url = escape(href);
    if (presentation.failedUrls?.has(href)) return shell(`<a href="${url}" target="_blank" rel="noopener noreferrer"><span class="inline-image-placeholder inline-image-error" role="alert">Image could not load. Open the original to try again.</span></a>`);
    return shell(`<img src="${url}" alt="${label}" crossorigin="anonymous" role="button" tabindex="0" data-inline-image="true" loading="lazy" decoding="async">`);
  }
  if (!image && !tag.definition && !presentation.streaming && presentation.images) {
    return shell(`<span class="inline-image-placeholder inline-image-error" role="alert">Image “${label}” is not available.</span>`);
  }
  const waiting = image?.waitingFor.length ? `<span>Waiting for ${escape(image.waitingFor.join(", "))}</span>` : "";
  return shell(`<span class="inline-image-placeholder" role="status" aria-busy="true"><strong>Generating image</strong>${waiting}</span>`);
}

export function installInlineImages(markdown: any) {
  markdown.inline.ruler.before("text", "inline_image", (state: any, silent: boolean) => {
    const images = state.env.inlineImages as Map<string, string> | undefined;
    if (!images || !state.src.startsWith("<\uE000", state.pos)) return false;
    const end = state.src.indexOf("\uE001>", state.pos);
    if (end < 0) return false;
    const key = state.src.slice(state.pos, end + 2);
    const html = images.get(key);
    if (html === undefined) return false;
    if (!silent) state.push("inline_image", "", 0).content = html;
    state.pos = end + 2;
    return true;
  });
  markdown.renderer.rules.inline_image = (tokens: any[], index: number) => tokens[index].content;
}

export function presentInlineImages(source: string, sessionId: string, presentation: ImagePresentation) {
  const inlineImages = new Map<string, string>();
  if (!presentation.assistant || !sessionId) return { source, inlineImages };
  const tags = parseInlineImageTags(source, { streaming: presentation.streaming });
  let prefix = "<\uE000image";
  while (source.includes(prefix)) prefix += "x";
  let result = "";
  let offset = 0;
  for (const [index, tag] of tags.entries()) {
    const key = `${prefix}${index}\uE001>`;
    inlineImages.set(key, imageHtml(tag, sessionId, presentation));
    result += source.slice(offset, tag.start) + key;
    offset = tag.end;
  }
  return { source: result + source.slice(offset), inlineImages };
}
