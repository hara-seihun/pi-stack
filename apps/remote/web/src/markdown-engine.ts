// markdown-it, texmath and the delimiter compatibility shim are 41 KB brotli
// plus their parse and setup cost, and the inbox, Workers, Files and Machine
// screens never render Markdown. So they are not in the page at startup: the
// first `Markdown` component to mount starts the download, and until the
// renderer exists the same component shows escaped source with its line breaks
// preserved, then re-renders when it arrives. KaTeX loads the same way one
// level below, on the first formula (`math-engine.ts`).
//
// Tests that already have the vendor scripts on `window` get a renderer
// synchronously from `markdownRenderer()`; anything asynchronous can await
// `ensureMarkdown()`.

import { appPath } from "./app-path";
import { installInlineImages } from "./inline-images";
import { katexEngine } from "./math-engine";
import { resourceUrl } from "./resource-url";

const SCRIPTS = ["vendor/markdown-it.min.js", "vendor/texmath.js", "vendor/pi-markdown-compat.js"];

const listeners = new Set<() => void>();
let renderer: MarkdownRenderer | null = null;
let loading: Promise<void> | null = null;

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

function loadStylesheet(href: string) {
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

/** `window` in a browser; the prepared global in a test that loaded the vendor scripts itself. */
function scope(): Partial<Window> {
  return (typeof window === "undefined" ? globalThis : window) as unknown as Partial<Window>;
}

function present() {
  return typeof scope().markdownit === "function" && !!scope().texmath;
}

function build(): MarkdownRenderer {
  const markdown = window.markdownit({ html: false, breaks: true, linkify: true })
    .use(window.texmath, {
      engine: katexEngine,
      delimiters: ["dollars", "brackets", "beg_end"],
      katexOptions: { throwOnError: false, strict: "ignore", trust: false },
    });
  const defaultImage = markdown.renderer.rules.image!;
  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    // Item text carries canonical context images as `/v1/sessions/:id/images/:hash`.
    // They need the person's endpoint and session the same way a tool result's
    // image blocks do.
    const src = tokens[index].attrGet?.("src");
    if (typeof src === "string") {
      if (src.startsWith("/v1/sessions/")) {
        tokens[index].attrSet("src", resourceUrl(src));
        tokens[index].attrSet("data-download-query", "true");
      }
      const resolved = tokens[index].attrGet?.("src");
      try {
        if (typeof resolved === "string" && (new URL(resolved, window.location.href).origin === window.location.origin || new URL(resolved, window.location.href).pathname.includes("/v1/sessions/"))) {
          tokens[index].attrSet("crossorigin", "anonymous");
        }
      } catch {}
    }
    tokens[index].attrSet("loading", "lazy");
    tokens[index].attrSet("decoding", "async");
    tokens[index].attrSet("tabindex", "0");
    tokens[index].attrSet("role", "button");
    return defaultImage(tokens, index, options, env, renderer);
  };
  const defaultLinkOpen = markdown.renderer.rules.link_open
    || ((tokens: any[], index: number, options: any, _env: any, renderer: any) => renderer.renderToken(tokens, index, options));
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, index, options, env, renderer);
  };
  installInlineImages(markdown);
  return markdown;
}

/** The renderer, or null while it is still downloading. */
export function markdownRenderer(): MarkdownRenderer | null {
  if (!renderer && present()) renderer = build();
  return renderer;
}

/** Starts the download once; resolves when the renderer is available. */
export function ensureMarkdown(): Promise<void> {
  if (markdownRenderer()) return Promise.resolve();
  if (!loading) {
    loadStylesheet(appPath("vendor/texmath.css"));
    // The scripts are independent globals, but `script.async = false` keeps
    // them executing in this order, so one failure names its own file.
    loading = SCRIPTS.reduce(
      (chain, script) => chain.then(() => loadScript(appPath(script))),
      Promise.resolve(),
    ).then(() => {
      if (!markdownRenderer()) throw new Error("The Markdown scripts loaded without a renderer");
      for (const listener of listeners) listener();
    }).catch((error) => { loading = null; throw error; });
  }
  return loading;
}

/** Called once the renderer exists, so mounted Markdown can render again. Returns the unsubscribe. */
export function onMarkdownReady(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The delimiter shim, or the source unchanged before it has loaded. */
export function normalizeLatex(source: string) {
  const normalize = scope().normalizeLatexDelimiters;
  return typeof normalize === "function" ? normalize(source) : source;
}

/** What a Markdown block shows while the renderer downloads: the source itself. */
export function plainMarkdownHtml(source: string) {
  return `<div class="markdown-plain">${escapeHtml(source)}</div>`;
}
