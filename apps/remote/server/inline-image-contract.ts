export type InlineImageErrorCode = "invalid_definition" | "missing_dependency" | "dependency_cycle" | "dependency_failed" | "input_error" | "provider_error" | "interrupted" | "publication_error";
export interface InlineImageDefinition { id: string; prompt: string; refs: string[] }
export interface InlineImage {
  id: string;
  prompt: string;
  refs: string[];
  state: "queued" | "generating" | "complete" | "error";
  createdAt: string;
  updatedAt: string;
  /** ID dependencies still in progress. */
  waitingFor: string[];
  error: { code: InlineImageErrorCode; message: string } | null;
  /** A later definition differed. The first definition and its result remain unchanged. */
  conflict: string | null;
  /** Absolute host path of the final PNG; use the session file endpoint to display it. */
  path: string | null;
  paths: string[];
  model: string | null;
  responseId: string | null;
}
export interface InlineImageSnapshot { version: number; images: InlineImage[] }
export interface InlineImageTag {
  start: number;
  end: number;
  id: string;
  definition: InlineImageDefinition | null;
  error: string | null;
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (raw, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? raw;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  });
}

/** UTF-16 source offsets, shared by the supervisor and renderer. Only closed tags count. */
export function parseInlineImageTags(source: string): InlineImageTag[] {
  const tags: InlineImageTag[] = [];
  let fence: { character: string; length: number } | null = null;
  let inlineTicks = 0;
  let comment = false;
  let rawBlock: string | null = null;
  let offset = 0;
  let consumedUntil = 0;
  for (const line of source.split(/(?<=\n)/)) {
    if (offset + line.length <= consumedUntil) { offset += line.length; continue; }
    const continuation = consumedUntil > offset;
    // Strip Markdown quote/list prefixes for code-block recognition, without changing offsets.
    const body = line.replace(/^(?: {0,3}> ?)+/, "").replace(/^ {0,3}(?:[-+*]|\d+[.)]) /, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(body);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      offset += line.length;
      continue;
    }
    if (!continuation && !inlineTicks && marker) { fence = { character: marker[1][0], length: marker[1].length }; offset += line.length; continue; }
    if (!continuation && /^(?: {4}|\t)/.test(body)) { offset += line.length; continue; }
    for (let i = Math.max(0, consumedUntil - offset); i < line.length;) {
      if (comment) { const end = line.indexOf("-->", i); if (end < 0) break; comment = false; i = end + 3; continue; }
      if (rawBlock) {
        const close = new RegExp(`</${rawBlock}\\s*>`, "i").exec(line.slice(i));
        if (!close) break;
        i += close.index + close[0].length; rawBlock = null; continue;
      }
      if (!inlineTicks && line.startsWith("<!--", i)) { comment = true; i += 4; continue; }
      if (line[i] === "\\" && !inlineTicks) { i += 2; continue; }
      if (line[i] === "`") {
        const ticks = /^`+/.exec(line.slice(i))![0].length;
        inlineTicks = inlineTicks === ticks ? 0 : inlineTicks || ticks;
        i += ticks; continue;
      }
      if (inlineTicks) { i++; continue; }
      const raw = /^<(pre|code|script|style)(?:\s[^>]*|)>/i.exec(line.slice(i));
      if (raw) { rawBlock = raw[1].toLowerCase(); i += raw[0].length; continue; }
      if (!line.startsWith("<pi-remote-image", i) || !/[\s/>]/.test(line[i + 16] ?? "")) { i++; continue; }
      const start = offset + i;
      const match = /^<pi-remote-image\b((?:[^'">]|"[^"]*"|'[^']*')*)\/>/.exec(source.slice(start));
      if (!match) { i++; continue; }
      const attributes: Record<string, string> = {};
      let rest = match[1];
      let error: string | null = null;
      while (rest.trim()) {
        const attribute = /^\s+([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
        if (!attribute) { error = "Attributes must have quoted values."; break; }
        const name = attribute[1];
        if (Object.hasOwn(attributes, name)) error = `Duplicate attribute: ${name}`;
        if (!["id", "prompt", "refs"].includes(name)) error = `Unknown attribute: ${name}`;
        attributes[name] = decodeAttribute(attribute[2] ?? attribute[3]);
        rest = rest.slice(attribute[0].length);
      }
      const id = attributes.id ?? "";
      if (!ID.test(id)) error = "Image ID must start with a letter and contain at most 64 letters, digits, underscores or hyphens.";
      let refs: string[] = [];
      if (attributes.refs !== undefined) {
        const value = attributes.refs.trim();
        if (value.startsWith("[")) {
          try { const parsed = JSON.parse(value); if (!Array.isArray(parsed) || parsed.some(v => typeof v !== "string")) throw new Error(); refs = parsed; }
          catch { error = "refs must be a comma-separated list or a JSON array of strings."; }
        } else refs = value ? value.split(",").map(v => v.trim()) : [];
        if (refs.length > 16 || refs.some(ref => !ID.test(ref) && !(ref.startsWith("/") && !ref.includes("\0")))) error = "Use at most 16 references, each an image ID or absolute file path.";
      }
      const prompt = attributes.prompt;
      if (prompt !== undefined && (!prompt.trim() || prompt.length > 32000)) error = "Image prompt must contain 1 to 32000 characters.";
      if (prompt === undefined && attributes.refs !== undefined) error = "Display-only tags accept only id.";
      tags.push({ start, end: start + match[0].length, id, definition: prompt === undefined ? null : { id, prompt, refs }, error });
      consumedUntil = start + match[0].length;
      i += match[0].length;
    }
    offset += line.length;
  }
  return tags;
}
