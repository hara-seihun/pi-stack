// KaTeX is 270 KB of script plus a stylesheet and fonts, and most
// conversations never contain a formula. The markdown pipeline asks this
// engine to render; until KaTeX has loaded, the engine answers with a plain
// placeholder and starts the download once. When KaTeX arrives, every
// subscriber re-renders and the placeholders become typeset formulas.
//
// Formulas already on screen never change, so compiled output is remembered:
// a streamed message renders again on every chunk and KaTeX is the expensive
// part of that.

import { appPath } from "./app-path";

type Katex = { renderToString(tex: string, options: { displayMode?: boolean }): string };

const formulas = new Map<string, string>();
const listeners = new Set<() => void>();
let katex: Katex | null = (globalThis as { katex?: Katex }).katex ?? null;
let loading: Promise<void> | null = null;

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
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

/** Starts loading KaTeX once; resolves when `renderToString` is available. */
export function ensureKatex(): Promise<void> {
  if (katex) return Promise.resolve();
  if (!loading) {
    loadStylesheet(appPath("vendor/katex/katex.min.css"));
    loading = loadScript(appPath("vendor/katex.min.js")).then(() => {
      katex = (globalThis as { katex?: Katex }).katex ?? null;
      if (!katex) throw new Error("KaTeX loaded without a renderer");
      for (const listener of listeners) listener();
    }).catch((error) => { loading = null; throw error; });
  }
  return loading;
}

/** Called after KaTeX becomes available, so cached renders can be refreshed. Returns the unsubscribe. */
export function onKatexReady(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const katexLoaded = () => katex !== null;

export const katexEngine = {
  renderToString(tex: string, options: { displayMode?: boolean }) {
    const key = `${options?.displayMode ? "block" : "inline"}\u0000${tex}`;
    const known = formulas.get(key);
    if (known !== undefined) return known;
    if (!katex) {
      void ensureKatex().catch(console.error);
      const tag = options?.displayMode ? "div" : "span";
      return `<${tag} class="math-pending">${escapeHtml(tex)}</${tag}>`;
    }
    const rendered = katex.renderToString(tex, options);
    if (formulas.size > 2_000) formulas.clear();
    formulas.set(key, rendered);
    return rendered;
  },
};
