// Chat messages are Markdown; a reader wants the words. This keeps every line
// break of the source, because segmentation happens on line breaks.

export function speechText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/<pi-remote-(?:file|image)\b[^>]*\/?>/g, "");
  text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, "Code omitted.");
  text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/gm, "Code omitted.");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/?[a-zA-Z][^>\n]*>/g, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/^[ \t]*\[[^\]]+\]:\s+\S+.*$/gm, "");
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm, "$1");
  text = text.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, "");
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*\n?/gm, "");
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_line, cells: string) => cells.split("|").map(cell => cell.trim()).filter(Boolean).join(", ") + ".");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(?<![\w*])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w*])/g, "$2");
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, "$1");
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
  text = text.replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

const SENTENCE_END = /(?<=[.!?…]["'”’)\]]?)\s+/;

function splitLongLine(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = () => { if (current.trim()) pieces.push(current.trim()); current = ""; };
  for (const sentence of line.split(SENTENCE_END)) {
    if (sentence.length > limit) {
      push();
      const words = sentence.split(/\s+/);
      for (const word of words) {
        if (current && current.length + 1 + word.length > limit) push();
        current = current ? `${current} ${word}` : word;
      }
      push();
      continue;
    }
    if (current && current.length + 1 + sentence.length > limit) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return pieces;
}

/** Lines are the unit: consecutive lines merge into one take while they fit,
 * a line never straddles two takes, and only a single line longer than the
 * limit is cut, at sentence boundaries. `limit` of 0 means one take. */
export function speechSegments(text: string, limit: number): string[] {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  if (limit <= 0) return [lines.join("\n")];
  const segments: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => { if (current.length) segments.push(current.join("\n")); current = []; size = 0; };
  for (const line of lines) {
    if (line.length > limit) {
      flush();
      segments.push(...splitLongLine(line, limit));
      continue;
    }
    if (size && size + 1 + line.length > limit) flush();
    current.push(line);
    size += (size ? 1 : 0) + line.length;
  }
  flush();
  return segments;
}
