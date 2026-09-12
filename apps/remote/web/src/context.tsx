import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { InlineImage } from "../../server/inline-image-contract";
import { installInlineImages, presentInlineImages, type ImagePresentation } from "./inline-images";
import { resourceUrl } from "./resource-url";

export const InlineImagesContext = createContext<ReadonlyMap<string, InlineImage> | null>(null);
import { API } from "../../server/api";
import { applyHtml } from "./markdown-dom";
import { streamingMarkdown } from "./streaming-markdown";
import { groupTranscriptEntries } from "./transcript-groups";
import type { ContextEntry } from "./types";

// A streamed message is rendered again on every chunk, and KaTeX is by far the
// most expensive part of that. The formulas already on screen never change, so
// remember what they compiled to.
const formulas = new Map<string, string>();
const katexEngine = {
  renderToString(tex: string, options: { displayMode?: boolean }) {
    const key = `${options?.displayMode ? "block" : "inline"}\u0000${tex}`;
    const known = formulas.get(key);
    if (known !== undefined) return known;
    const rendered = window.katex.renderToString(tex, options);
    if (formulas.size > 2_000) formulas.clear();
    formulas.set(key, rendered);
    return rendered;
  },
};

const markdown = window.markdownit({ html: false, breaks: true, linkify: true })
  .use(window.texmath, {
    engine: katexEngine,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: { throwOnError: false, strict: "ignore", trust: false },
  });
const defaultImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet("loading", "lazy");
  tokens[index].attrSet("decoding", "async");
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

const INLINE_IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

// A file tag naming an image shows the picture itself; any other file becomes
// a download link. The link stays under an image so the original can be saved.
function presentationMarkdown(source: string, sessionId: string) {
  return source.replace(/<pi-remote-file\s+src=["']([^"']+)["']\s*\/\s*>/gi, (_match, path) => {
    const name = String(path).split("/").filter(Boolean).at(-1) || "Download file";
    const label = name.replaceAll("&", "&amp;").replaceAll("[", "&#91;").replaceAll("]", "&#93;").replace(/[\r\n]+/g, " ");
    const link = API.sessionFiles.path({ sessionId }, { path });
    const href = resourceUrl(link);
    if (INLINE_IMAGE.test(name)) return `\n\n[![${label}](${href})](${href})\n\n`;
    return `\n\n[${label}](${href})\n\n`;
  });
}

export function renderMarkdown(source: string, sessionId: string, streaming = false, presentation: ImagePresentation = {}) {
  const prepared = presentInlineImages(source || "", sessionId, { ...presentation, streaming });
  const normalized = window.normalizeLatexDelimiters(presentationMarkdown(prepared.source, sessionId));
  return markdown.render(streaming ? streamingMarkdown(normalized) : normalized, { inlineImages: prepared.inlineImages });
}

export const Markdown = memo(function Markdown({ source, sessionId, streaming = false, assistant = false, className = "markdown-body" }: { source: string; sessionId: string; streaming?: boolean; assistant?: boolean; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const images = useContext(InlineImagesContext);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(() => new Set());
  const html = useMemo(() => renderMarkdown(source, sessionId, streaming, { assistant, images, failedUrls }), [source, sessionId, streaming, assistant, images, failedUrls]);
  useLayoutEffect(() => { if (element.current) applyHtml(element.current, html); }, [html]);
  return <div ref={element} className={className} onErrorCapture={(event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.dataset.inlineImage) {
      const url = image.getAttribute("src");
      if (url) setFailedUrls(current => new Set([...current, url]));
    }
  }} />;
});

function formatJson(value: unknown) {
  try { return JSON.stringify(value ?? {}, null, 2); }
  catch { return String(value ?? ""); }
}

function fencedContext(value: unknown, language = "json") {
  const text = String(value ?? "");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function imageUrl(block: any): string {
  if (typeof block.src === "string" && block.src.startsWith("/v1/sessions/")) {
    return resourceUrl(block.src);
  }
  return block.data ? `data:${block.mimeType};base64,${block.data}` : "";
}

function contextContentMarkdown(content: any, includeImages = true): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fencedContext(formatJson(content));
  return content.map((block) => {
    if (!block || typeof block !== "object") return fencedContext(formatJson(block));
    if (block.type === "text") return String(block.text || "");
    if (block.type === "thinking") return `*Thinking*\n\n${String(block.thinking || "")}`;
    if (block.type === "image") {
      const mime = String(block.mimeType || "application/octet-stream");
      const src = includeImages ? imageUrl(block) : "";
      return src ? `![Context image](${src})` : `*Image · ${mime}*`;
    }
    if (block.type === "toolCall") {
      const namespace = block.namespace ? `${block.namespace}.` : "";
      return `**Tool call · ${namespace}${String(block.name || "tool")}**\n\n${fencedContext(formatJson(block.arguments))}`;
    }
    return fencedContext(formatJson(block));
  }).filter(Boolean).join("\n\n");
}

export function modelContextEntries(context: any): ContextEntry[] {
  if (!context) return [{ key: "waiting", signature: "waiting", kind: "notice", label: "Context", text: "Context will appear when the agent makes its next model request." }];
  const entries: ContextEntry[] = [{
    key: "system", signature: `system:${context.systemPrompt || ""}`, kind: "system", label: "System", text: String(context.systemPrompt || ""),
  }];
  for (const [index, tool] of (context.tools || []).entries()) entries.push({
    key: `tool:${index}:${tool.name || "tool"}`,
    signature: `tool:${JSON.stringify(tool)}`,
    kind: "tool",
    label: `Tool · ${tool.name || "tool"}`,
    text: `${String(tool.description || "")}\n\n${fencedContext(formatJson(tool.parameters))}`.trim(),
  });
  const results = new Map((context.messages || []).filter((message: any) => message?.role === "toolResult")
    .map((message: any) => [String(message.toolCallId || ""), message]));
  const pairedResults = new Set<any>();
  for (const [messageIndex, message] of (context.messages || []).entries()) {
    const role = String(message?.role || "message");
    if (role === "assistant" && Array.isArray(message.content)) {
      for (const [blockIndex, block] of message.content.entries()) {
        if (block?.type === "toolCall") {
          const result = results.get(String(block.id || ""));
          if (result) pairedResults.add(result);
          entries.push({ key: `toolCall:${block.id || `${message.timestamp || messageIndex}:${blockIndex}`}`, signature: `toolCall:${JSON.stringify(block)}:${JSON.stringify(result || null)}`, kind: "toolCall", toolCall: block, toolResult: result, time: message.timestamp });
        } else if (block?.type === "thinking") entries.push({ key: `assistant:${message.timestamp || messageIndex}:${blockIndex}:thinking`, signature: `thinking:${JSON.stringify(block)}`, kind: "thinking", label: "Thinking", text: String(block.thinking || "") });
        else entries.push({ key: `assistant:${message.timestamp || messageIndex}:${blockIndex}:${block?.type || "content"}`, signature: `assistant:${JSON.stringify(block)}`, kind: "assistant", label: "Assistant", text: contextContentMarkdown([block]) });
      }
      if (message.content.length === 0 && message.errorMessage) entries.push({ key: `assistant:${message.timestamp || messageIndex}:error`, signature: `assistant-error:${message.errorMessage}`, kind: "notice", label: "Assistant error", text: String(message.errorMessage) });
      continue;
    }
    if (role === "toolResult" && pairedResults.has(message)) continue;
    entries.push({
      key: `message:${role}:${message?.timestamp || messageIndex}:${message?.toolCallId || ""}`,
      signature: `message:${JSON.stringify(message)}`,
      kind: role === "user" ? "user" : role === "assistant" ? "assistant" : role === "toolResult" && message?.isError ? "notice" : "tool",
      label: role === "user" ? "User" : role === "assistant" ? "Assistant" : role === "toolResult" ? `Tool result · ${message.toolName || "tool"}` : role,
      text: contextContentMarkdown(message?.content),
      messageTimestamp: Number(message?.timestamp || 0),
    });
  }
  return entries;
}

const ClipboardIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2M9 5h6"/></svg>;
const PencilIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.2 8.4 8.4 21.2a2 2 0 0 1-1.4.6H3.3a1 1 0 0 1-1-1V17a2 2 0 0 1 .6-1.4L15.6 2.8a2 2 0 0 1 2.8 0l2.8 2.8a2 2 0 0 1 0 2.8ZM14 4l6 6"/></svg>;

export function CopyButton({ text, label = "Copy message", className = "message-action" }: { text: string; label?: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setStatus("copied"); }
    catch { setStatus("failed"); }
    setTimeout(() => setStatus("idle"), 1_200);
  };
  const description = status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label;
  return <button type="button" className={`${className}${status === "idle" ? "" : ` ${status}`}`} title={description} aria-label={description} onClick={copy}><ClipboardIcon /></button>;
}

const MessageEntry = memo(function MessageEntry({ entry, sessionId, onEdit }: { entry: ContextEntry; sessionId: string; onEdit(entry: ContextEntry): void }) {
  const text = entry.text || "";
  return <div className={`message ${entry.kind}`}>
    <div className="message-header">
      <span className="message-label">{(entry.label || entry.kind).toUpperCase()}</span>
      <div className="message-actions">
        <CopyButton text={text} />
        {entry.kind === "user" && Number(entry.messageTimestamp) > 0 && <button type="button" className="message-action edit-message" title="Edit and resend from this point in the conversation" aria-label="Edit and resend from this point in the conversation" onClick={() => onEdit(entry)}><PencilIcon /></button>}
      </div>
    </div>
    <Markdown source={text} sessionId={sessionId} streaming={entry.streaming} assistant={entry.kind === "assistant"} />
  </div>;
}, (before, after) => before.entry.signature === after.entry.signature && before.sessionId === after.sessionId && before.onEdit === after.onEdit);

function shortPath(path: string, home: string) {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
function toolSummary(name: string, args: any, home: string) {
  const tool = (name || "tool").toLowerCase();
  const path = args.path || args.file_path || "";
  if (tool === "bash") return `$ ${args.command || ""}`;
  if (tool === "read") {
    const start = args.offset ?? 1;
    const range = args.offset !== undefined || args.limit !== undefined ? `:${start}${args.limit !== undefined ? `-${start + args.limit - 1}` : ""}` : "";
    return `read ${shortPath(path, home)}${range}`;
  }
  if (tool === "edit") return `edit ${shortPath(path, home)}${Array.isArray(args.edits) && args.edits.length > 1 ? ` · ${args.edits.length} changes` : ""}`;
  if (tool === "write") return `write ${shortPath(path, home)}`;
  return tool;
}
function toolInput(name: string, args: any) {
  const tool = (name || "").toLowerCase();
  if (tool === "write") return args.content || "";
  if (tool === "edit" && Array.isArray(args.edits)) return args.edits.slice(0, 3).map((edit: any) => `− ${edit.oldText || ""}\n+ ${edit.newText || ""}`).join("\n");
  return ["bash", "read", "grep", "find", "ls"].includes(tool) ? "" : formatJson(args);
}
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const ToolEntry = memo(function ToolEntry({ entry, home }: { entry: ContextEntry; home: string }) {
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [, tick] = useState(0);
  const call = entry.toolCall || {};
  const args = call.arguments || {};
  const result = entry.toolResult;
  const expanded = !result || completedExpanded;
  const startedAt = Number(entry.time || Date.now());
  const endedAt = Number(result?.timestamp || 0);
  useEffect(() => {
    if (result) return;
    const timer = setInterval(() => tick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [result]);
  const input = toolInput(call.name, args);
  const output = result ? contextContentMarkdown(result.content, false) : "";
  const images = Array.isArray(result?.content) ? result.content.filter((block: any) => block?.type === "image") : [];
  const body = [input, output].filter(Boolean).join("\n\n");
  const summary = toolSummary(call.name, args, home);
  const expandable = summary.length > 100 || body.length > 320 || body.split("\n").length > 5;
  const timeout = args.timeoutMs !== undefined ? Math.max(0, Number(args.timeoutMs)) : args.timeout !== undefined ? Math.max(0, Number(args.timeout) * 1000) : -1;
  const started = new Date(startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const timing = `Started ${started} · ${result ? "ran" : "elapsed"} ${duration((endedAt || Date.now()) - startedAt)} · ${timeout >= 0 ? `timeout ${duration(timeout)}` : "no timeout"}`;
  return <div className={`tool-card${expanded ? "" : " collapsed"}${result ? result.isError ? " error" : " success" : ""}`}>
    <pre className="tool-header">{result ? result.isError ? "×  " : "✓  " : "…  "}{summary}</pre>
    <div className="tool-timing">{timing}</div>
    {body && <pre className="tool-body">{expanded ? body : body.slice(0, 320)}</pre>}
    {expanded && images.map((image: any, index: number) => <img key={index} className="context-image" src={imageUrl(image)} alt="Tool result" loading="lazy" decoding="async" />)}
    {result && (expandable || images.length > 0) && <button type="button" className="tool-toggle" onClick={() => setCompletedExpanded(!completedExpanded)}>{completedExpanded ? "Show less" : "Show more"}</button>}
    <div className="message-actions"><CopyButton text={[summary, body].filter(Boolean).join("\n\n")} /></div>
  </div>;
}, (before, after) => before.entry.signature === after.entry.signature && before.home === after.home);

function DetailEntry({ entry, sessionId, home, onEdit }: { entry: ContextEntry; sessionId: string; home: string; onEdit(entry: ContextEntry): void }) {
  return entry.kind === "toolCall"
    ? <ToolEntry entry={entry} home={home} />
    : <MessageEntry entry={entry} sessionId={sessionId} onEdit={onEdit} />;
}

function DetailGroup({ entries, newest, sessionId, home, onEdit }: { entries: ContextEntry[]; newest: boolean; sessionId: string; home: string; onEdit(entry: ContextEntry): void }) {
  const [expanded, setExpanded] = useState(false);
  const count = entries.length;
  const running = entries.some((entry) => entry.streaming || entry.kind === "toolCall" && !entry.toolResult);
  const latest = entries.at(-1);
  return <div className={`detail-group${running ? " running" : ""}`}>
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="detail-group-chevron" aria-hidden="true">›</span>
        <span className="detail-group-label">Agent details</span>
        <span className="detail-group-count">{count} {count === 1 ? "box" : "boxes"}</span>
      </summary>
      {expanded && <div className="detail-group-entries">{entries.map((entry) => <DetailEntry key={entry.key} entry={entry} sessionId={sessionId} home={home} onEdit={onEdit} />)}</div>}
    </details>
    {!expanded && newest && latest && <div className="detail-group-entries detail-group-latest"><DetailEntry key={latest.key} entry={latest} sessionId={sessionId} home={home} onEdit={onEdit} /></div>}
  </div>;
}

const CONTEXT_WINDOW_SIZE = 60;
export function ContextTranscript({ entries, liveThinking, sessionId, home, onEdit }: { entries: ContextEntry[]; liveThinking?: string; sessionId: string; home: string; onEdit(entry: ContextEntry): void }) {
  const items = useMemo(() => groupTranscriptEntries(liveThinking ? [...entries, {
    key: "live-thinking", signature: `live-thinking:${liveThinking}`, kind: "thinking", label: "Thinking", text: liveThinking, streaming: true,
  }] : entries), [entries, liveThinking]);
  const newest = Math.max(0, items.length - CONTEXT_WINDOW_SIZE);
  const [start, setStart] = useState(newest);
  const previousCount = useRef(0);
  useEffect(() => { previousCount.current = 0; setStart(newest); }, [sessionId]);
  useEffect(() => {
    setStart((value) => previousCount.current === 0 ? newest : Math.min(value, newest));
    previousCount.current = items.length;
  }, [items.length, newest]);
  return <div className="transcript">
    {start > 0 && <button type="button" className="context-earlier" onClick={() => setStart(Math.max(0, start - CONTEXT_WINDOW_SIZE))}>Show {Math.min(CONTEXT_WINDOW_SIZE, start)} earlier entries</button>}
    {items.slice(start).map((item, index, visible) => item.kind === "details"
      ? <DetailGroup key={`${sessionId}:${item.key}`} entries={item.entries} newest={index === visible.length - 1} sessionId={sessionId} home={home} onEdit={onEdit} />
      : <MessageEntry key={item.key} entry={item.entry} sessionId={sessionId} onEdit={onEdit} />)}
  </div>;
}
