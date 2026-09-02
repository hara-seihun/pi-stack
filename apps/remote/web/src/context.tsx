import { memo, useEffect, useMemo, useRef, useState } from "react";
import { API } from "../../server/api";
import type { ContextEntry } from "./types";

const markdown = window.markdownit({ html: false, breaks: true, linkify: true })
  .use(window.texmath, {
    engine: window.katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: { throwOnError: false, strict: "ignore", trust: false },
  });
const defaultLinkOpen = markdown.renderer.rules.link_open
  || ((tokens: any[], index: number, options: any, _env: any, renderer: any) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, env, renderer);
};

function presentationMarkdown(source: string, sessionId: string) {
  return source.replace(/<pi-remote-file\s+src=["']([^"']+)["']\s*\/\s*>/gi, (_match, path) => {
    const name = String(path).split("/").filter(Boolean).at(-1) || "Download file";
    const label = name.replaceAll("&", "&amp;").replaceAll("[", "&#91;").replaceAll("]", "&#93;").replace(/[\r\n]+/g, " ");
    return `\n\n[${label}](${API.sessionFiles.path({ sessionId }, { path })})\n\n`;
  });
}

export const Markdown = memo(function Markdown({ source, sessionId, className = "markdown-body" }: { source: string; sessionId: string; className?: string }) {
  const html = useMemo(() => {
    try { return markdown.render(window.normalizeLatexDelimiters(presentationMarkdown(source || "", sessionId))); }
    catch { return ""; }
  }, [source, sessionId]);
  return html
    ? <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
    : <div className={className}>{source}</div>;
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

function contextContentMarkdown(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fencedContext(formatJson(content));
  return content.map((block) => {
    if (!block || typeof block !== "object") return fencedContext(formatJson(block));
    if (block.type === "text") return String(block.text || "");
    if (block.type === "thinking") return `*Thinking*\n\n${String(block.thinking || "")}`;
    if (block.type === "image") {
      const mime = String(block.mimeType || "application/octet-stream");
      const data = String(block.data || "");
      return data ? `![Context image](data:${mime};base64,${data})` : `*Image · ${mime}*`;
    }
    if (block.type === "toolCall") {
      const namespace = block.namespace ? `${block.namespace}.` : "";
      return `**Tool call · ${namespace}${String(block.name || "tool")}**\n\n${fencedContext(formatJson(block.arguments))}`;
    }
    return fencedContext(formatJson(block));
  }).filter(Boolean).join("\n\n");
}

export function modelContextEntries(context: any): ContextEntry[] {
  if (!context) return [{ key: "waiting", signature: "waiting", kind: "notice", label: "Context", text: "Context will appear when Pi makes its next model request." }];
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
    if (role === "custom" && message?.customType === "pi-remote-context-compacted") {
      entries.push({ key: `context-compacted:${message.timestamp || messageIndex}`, signature: `context-compacted:${message.timestamp || messageIndex}`, kind: "notice", label: "Context", text: "Context compacted" });
      continue;
    }
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
    <Markdown source={text} sessionId={sessionId} />
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
  const [expanded, setExpanded] = useState(false);
  const [, tick] = useState(0);
  const call = entry.toolCall || {};
  const args = call.arguments || {};
  const result = entry.toolResult;
  const startedAt = Number(entry.time || Date.now());
  const endedAt = Number(result?.timestamp || 0);
  useEffect(() => {
    if (result) return;
    const timer = setInterval(() => tick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [result]);
  const input = toolInput(call.name, args);
  const output = result ? contextContentMarkdown(result.content) : "";
  const body = [input, output].filter(Boolean).join("\n\n");
  const summary = toolSummary(call.name, args, home);
  const expandable = summary.length > 100 || body.length > 320 || body.split("\n").length > 5;
  const timeout = args.timeoutMs !== undefined ? Math.max(0, Number(args.timeoutMs)) : args.timeout !== undefined ? Math.max(0, Number(args.timeout) * 1000) : -1;
  const started = new Date(startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const timing = `Started ${started} · ${result ? "ran" : "elapsed"} ${duration((endedAt || Date.now()) - startedAt)} · ${timeout >= 0 ? `timeout ${duration(timeout)}` : "no timeout"}`;
  return <div className={`tool-card${expanded ? "" : " collapsed"}${result ? result.isError ? " error" : " success" : ""}`}>
    <pre className="tool-header">{result ? result.isError ? "×  " : "✓  " : "…  "}{summary}</pre>
    <div className="tool-timing">{timing}</div>
    {body && <pre className="tool-body">{body}</pre>}
    {expandable && <button type="button" className="tool-toggle" onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>}
    <div className="message-actions"><CopyButton text={[summary, body].filter(Boolean).join("\n\n")} /></div>
  </div>;
}, (before, after) => before.entry.signature === after.entry.signature && before.home === after.home);

const CONTEXT_WINDOW_SIZE = 60;
export function ContextTranscript({ entries, sessionId, home, onEdit }: { entries: ContextEntry[]; sessionId: string; home: string; onEdit(entry: ContextEntry): void }) {
  const newest = Math.max(0, entries.length - CONTEXT_WINDOW_SIZE);
  const [start, setStart] = useState(newest);
  const previousCount = useRef(0);
  useEffect(() => { previousCount.current = 0; setStart(newest); }, [sessionId]);
  useEffect(() => {
    setStart((value) => previousCount.current === 0 ? newest : Math.min(value, newest));
    previousCount.current = entries.length;
  }, [entries.length, newest]);
  return <div className="transcript">
    {start > 0 && <button type="button" className="context-earlier" onClick={() => setStart(Math.max(0, start - CONTEXT_WINDOW_SIZE))}>Show {Math.min(CONTEXT_WINDOW_SIZE, start)} earlier entries</button>}
    {entries.slice(start).map((entry) => entry.kind === "toolCall"
      ? <ToolEntry key={entry.key} entry={entry} home={home} />
      : <MessageEntry key={entry.key} entry={entry} sessionId={sessionId} onEdit={onEdit} />)}
  </div>;
}
