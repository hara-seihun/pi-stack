// `<pi-remote-file src="/absolute/path" />` in a message becomes the richest
// presentation the client can give that file: a picture, an audio or video
// player, an embedded PDF, or the start of a text file. Anything else is a
// download link. Every presentation keeps the file name as a download link
// beneath it, so a format the browser cannot decode still reaches the reader.
//
// Markdown is rendered with raw HTML disabled, so an inline rule turns the
// tag into tokens; inside code it stays text. The text and PDF views are custom elements whose content lives in a shadow root:
// re-rendering a streaming message patches the light DOM (`applyHtml`) and
// would otherwise wipe what they loaded.
import { API } from "../../server/api";
import { fileKind } from "./features/files/file-kind";
import { resourceUrl } from "./resource-url";

const FILE_TAG_AT = /^<pi-remote-file\s+src=["']([^"']+)["']\s*\/\s*>/i;
/** Image formats every client can draw; HEIC and TIFF stay links. */
const BROWSER_IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
export const TEXT_PREVIEW_BYTES = 65_536;

function escape(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function fileUrl(sessionId: string, path: string, inline = false) {
  return resourceUrl(API.sessionFiles.path({ sessionId }, inline ? { path, inline: 1 } : { path }));
}

function caption(name: string, href: string) {
  return `<span class="inline-file-caption"><a href="${escape(href)}" download="${escape(name)}" target="_blank" rel="noopener noreferrer">${escape(name)}</a></span>`;
}

/** The HTML for one file tag, or null when a Markdown image or link presents it. */
export function inlineFileHtml(path: string, sessionId: string): string | null {
  const name = path.split("/").filter(Boolean).at(-1) || "Download file";
  const href = fileUrl(sessionId, path);
  const url = escape(href);
  const label = escape(name);
  switch (fileKind(name)) {
    case "audio":
      return `<span class="inline-file inline-file-audio"><audio controls preload="metadata" src="${url}" aria-label="${label}"></audio>${caption(name, href)}</span>`;
    case "video":
      return `<span class="inline-file inline-file-video"><video controls preload="metadata" playsinline src="${url}" aria-label="${label}"></video>${caption(name, href)}</span>`;
    case "pdf":
      return `<span class="inline-file inline-file-pdf"><pi-inline-pdf src="${escape(fileUrl(sessionId, path, true))}" name="${label}"></pi-inline-pdf>${caption(name, href)}</span>`;
    case "text":
    case "markdown":
      return `<span class="inline-file inline-file-text"><pi-inline-text src="${url}" name="${label}"></pi-inline-text>${caption(name, href)}</span>`;
    default:
      return null;
  }
}

/**
 * Presents file tags as an inline Markdown rule, so a tag inside a code span,
 * a fence or an indented block stays literal text. The session comes from the
 * render environment's `sessionId`.
 */
export function installInlineFiles(markdown: any) {
  markdown.inline.ruler.before("text", "inline_file", (state: any, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x3c || !state.src.startsWith("<pi-remote-file", state.pos)) return false;
    const match = FILE_TAG_AT.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const path = match[1];
      const sessionId = String(state.env?.sessionId ?? "");
      const name = path.split("/").filter(Boolean).at(-1) || "Download file";
      const href = fileUrl(sessionId, path);
      const rich = BROWSER_IMAGE.test(name) ? null : inlineFileHtml(path, sessionId);
      if (rich !== null) state.push("inline_file", "", 0).content = rich;
      else if (BROWSER_IMAGE.test(name)) {
        // A real image token, so the image rule adds the lazy loading, CORS and tap behavior every Markdown image has.
        const image = state.push("image", "img", 0);
        image.attrs = [["src", href], ["alt", ""]];
        const text = new state.Token("text", "", 0);
        text.content = name;
        image.children = [text];
        image.content = name;
      } else {
        state.push("link_open", "a", 1).attrs = [["href", href]];
        state.push("text", "", 0).content = name;
        state.push("link_close", "a", -1);
      }
    }
    state.pos += match[0].length;
    return true;
  });
  markdown.renderer.rules.inline_file = (tokens: any[], index: number) => tokens[index].content;
}

/** Text shown for the first bytes of a file: pretty JSON when the whole document arrived. */
export function textPreview(bytes: Uint8Array, name: string, complete: boolean): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (complete && /\.json$/i.test(name)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  return text;
}

const SHARED_STYLE = `:host { display: block; }
[hidden] { display: none !important; }
.frame { display: block; border: 1px solid var(--border, #ccc); border-radius: 12px; background: var(--surface-2, transparent); overflow: hidden; }
.status { display: block; padding: 12px 14px; color: var(--muted, #777); font-size: 13px; }
.error { color: var(--danger, #c33); }`;

function defineInlineTextElement() {
  class InlineText extends HTMLElement {
    static observedAttributes = ["src"];
    #controller: AbortController | null = null;
    #loaded = "";
    readonly #root: ShadowRoot;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: "open" });
      this.#root.innerHTML = `<style>${SHARED_STYLE}
pre { margin: 0; padding: 10px 12px; max-height: 22em; overflow: auto; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text, inherit); white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
pre.expanded { max-height: none; }
.bar { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 6px 12px; border-top: 1px solid var(--border, #ccc); color: var(--muted, #777); font-size: 12px; }
button { font: inherit; color: var(--accent, inherit); background: none; border: 0; padding: 4px 0; cursor: pointer; }
</style><span class="frame"><span class="status" role="status">Loading preview…</span><pre hidden></pre><span class="bar" hidden><span class="note"></span><button type="button">Expand</button></span></span>`;
      const pre = this.#root.querySelector("pre")!;
      const button = this.#root.querySelector("button")!;
      button.addEventListener("click", () => {
        const expanded = pre.classList.toggle("expanded");
        button.textContent = expanded ? "Collapse" : "Expand";
      });
    }

    connectedCallback() { this.#load(); }
    disconnectedCallback() { this.#controller?.abort(); this.#controller = null; }
    attributeChangedCallback() { if (this.isConnected) this.#load(); }

    #load() {
      const src = this.getAttribute("src");
      if (!src || src === this.#loaded) return;
      this.#loaded = src;
      this.#controller?.abort();
      const controller = new AbortController();
      this.#controller = controller;
      const status = this.#root.querySelector(".status") as HTMLElement;
      const pre = this.#root.querySelector("pre")!;
      const bar = this.#root.querySelector(".bar") as HTMLElement;
      const note = this.#root.querySelector(".note")!;
      status.hidden = false;
      status.className = "status";
      status.textContent = "Loading preview…";
      pre.hidden = true;
      bar.hidden = true;
      void (async () => {
        try {
          const response = await fetch(src, { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` }, signal: controller.signal, cache: "no-store" });
          if (!response.ok) throw new Error(response.status === 404 ? "File not found" : `Could not load preview, HTTP ${response.status}`);
          const total = Number(response.headers.get("content-range")?.split("/").at(-1) ?? response.headers.get("content-length") ?? NaN);
          const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, TEXT_PREVIEW_BYTES);
          if (controller.signal.aborted) return;
          const complete = !(total > bytes.length);
          pre.textContent = textPreview(bytes, this.getAttribute("name") || "", complete) || " ";
          pre.hidden = false;
          status.hidden = true;
          note.textContent = complete ? "" : `First ${TEXT_PREVIEW_BYTES / 1024} KiB`;
          bar.hidden = false;
        } catch (cause) {
          if (controller.signal.aborted) return;
          this.#loaded = "";
          status.className = "status error";
          status.textContent = cause instanceof Error ? cause.message : "Could not load preview";
        }
      })();
    }
  }
  customElements.define("pi-inline-text", InlineText);
}

function defineInlinePdfElement() {
  class InlinePdf extends HTMLElement {
    static observedAttributes = ["src"];
    readonly #root: ShadowRoot;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: "open" });
    }

    connectedCallback() { this.#render(); }
    attributeChangedCallback() { if (this.isConnected) this.#render(); }

    // Android WebView and mobile browsers have no PDF viewer: an iframe there
    // is an empty box or a surprise download, so those show the link alone.
    #render() {
      const src = this.getAttribute("src");
      const frame = this.#root.querySelector("iframe");
      if (!src || !(navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled) {
        this.#root.replaceChildren();
        return;
      }
      if (frame?.getAttribute("src") === src) return;
      this.#root.innerHTML = `<style>${SHARED_STYLE}
iframe { display: block; width: 100%; height: min(70vh, 720px); border: 0; background: #fff; }</style><span class="frame"><iframe></iframe></span>`;
      const iframe = this.#root.querySelector("iframe")!;
      iframe.title = this.getAttribute("name") || "PDF";
      iframe.src = src;
    }
  }
  customElements.define("pi-inline-pdf", InlinePdf);
}

if (typeof customElements !== "undefined" && typeof HTMLElement !== "undefined") {
  if (!customElements.get("pi-inline-text")) defineInlineTextElement();
  if (!customElements.get("pi-inline-pdf")) defineInlinePdfElement();
}
