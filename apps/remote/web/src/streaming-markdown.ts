// Rendering a partly streamed message as Markdown means every appended chunk
// must leave a document that parses the same way the finished one will. Two
// moves do that: close constructs whose meaning is already settled (a fence, a
// code span, an emphasis run), and hide constructs whose meaning is still
// undecided (half a link, half a formula, a table without its delimiter row).
// Nothing here ever falls back to raw text, so a paragraph never flips between
// source and rendered form while it grows.

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const FENCE_MARKER = /^([ \t]*)(`{3,}|~{3,})/;
const BLANK_LINE = /^[ \t]*$/;
const BEGIN_ENVIRONMENT = /^\\begin\{([^}\n]*)\}/;
const END_ENVIRONMENT = /^\\end\{([^}\n]*)\}/;
const TABLE_ROW = /^ {0,3}\|/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INCOMPLETE_MARKER = /^[ \t]*(?:#{1,6}|[-*+=_>]+|\d{1,9}[.)]|`{1,2}|~{1,2}|\|)[ \t]*$/;
const FILE_TAG = "<pi-remote-file";

type Fence = { indent: string; marker: string };
type Emphasis = { marker: string; length: number };
type Scan = { fence: Fence | null; truncate: number | null; codeTicks: number; emphasis: Emphasis[] };

function runLength(line: string, index: number, character: string) {
  let end = index;
  while (line[end] === character) end++;
  return end - index;
}

function flanking(previous: string, next: string) {
  const previousWhitespace = previous === "" || /\s/.test(previous);
  const nextWhitespace = next === "" || /\s/.test(next);
  const previousPunctuation = previous !== "" && ASCII_PUNCTUATION.test(previous);
  const nextPunctuation = next !== "" && ASCII_PUNCTUATION.test(next);
  return {
    left: !nextWhitespace && (!nextPunctuation || previousWhitespace || previousPunctuation),
    right: !previousWhitespace && (!previousPunctuation || nextWhitespace || nextPunctuation),
    previousPunctuation,
    nextPunctuation,
  };
}

// texmath accepts `$x$` only when the closing dollar follows a non-space,
// non-backslash character and is not glued to a digit, which is what keeps
// prices out of KaTeX. Mirror that so a partial line hides exactly the spans
// the finished line will turn into math.
function inlineMathClose(line: string, from: number) {
  for (let index = from; index < line.length; index++) {
    if (line[index] !== "$") continue;
    const previous = line[index - 1] ?? "";
    const next = line[index + 1] ?? "";
    if (index === from) return -1;
    if (/\s/.test(previous) || previous === "\\") continue;
    if (/[0-9]/.test(next)) continue;
    return index;
  }
  return -1;
}

function scanDocument(source: string): Scan {
  const lines = source.split("\n");
  let fence: Fence | null = null;
  let display: number | null = null;
  let codeTicks = 0;
  let links: number[] = [];
  let emphasis: Emphasis[] = [];
  const environments: { start: number; name: string }[] = [];
  let candidate: number | null = null;
  const propose = (index: number) => { if (candidate === null || index < candidate) candidate = index; };
  // A marker sitting at the very end of what has arrived carries no content
  // yet, and Markdown prints such a run literally, so it waits out of sight
  // until the character that decides what it means shows up.
  const dangle = (index: number, length: number) => { if (index + length === source.length) propose(index); };

  let base = 0;
  for (const [number, line] of lines.entries()) {
    const start = base;
    base += line.length + 1;
    const finalLine = number === lines.length - 1;

    if (fence) {
      const closing = FENCE_MARKER.exec(line);
      if (closing && closing[2][0] === fence.marker[0] && closing[2].length >= fence.marker.length && line.slice(closing[0].length).trim() === "") fence = null;
      continue;
    }
    if (display === null) {
      if (BLANK_LINE.test(line)) { codeTicks = 0; links = []; emphasis = []; continue; }
      const opening = FENCE_MARKER.exec(line);
      if (opening) { fence = { indent: opening[1], marker: opening[2] }; codeTicks = 0; links = []; emphasis = []; continue; }
    }

    let index = 0;
    while (index < line.length) {
      if (display !== null) {
        const closing = line.indexOf("$$", index);
        if (closing < 0) { index = line.length; break; }
        display = null;
        index = closing + 2;
        continue;
      }
      const character = line[index];
      if (codeTicks > 0) {
        if (character === "`") {
          const run = runLength(line, index, "`");
          if (run === codeTicks) codeTicks = 0;
          index += run;
          continue;
        }
        index++;
        continue;
      }
      if (character === "`") {
        const run = runLength(line, index, "`");
        dangle(start + index, run);
        codeTicks = run;
        index += run;
        continue;
      }
      if (character === "\\") {
        const rest = line.slice(index);
        const opening = BEGIN_ENVIRONMENT.exec(rest);
        if (opening) { environments.push({ start: start + index, name: opening[1] }); index += opening[0].length; continue; }
        const closing = END_ENVIRONMENT.exec(rest);
        if (closing) {
          if (environments.at(-1)?.name === closing[1]) environments.pop();
          index += closing[0].length;
          continue;
        }
        index += 2;
        continue;
      }
      if (character === "$") {
        const run = runLength(line, index, "$");
        if (run >= 2) { display = start + index; index += 2; continue; }
        const next = line[index + 1] ?? "";
        const previous = line[index - 1] ?? "";
        const opens = next !== "" && !/\s/.test(next) && !/[0-9]/.test(next) && !/[0-9]/.test(previous);
        if (!opens) { dangle(start + index, run); index++; continue; }
        const closing = inlineMathClose(line, index + 1);
        if (closing < 0) {
          if (finalLine) propose(start + index);
          index++;
          continue;
        }
        index = closing + 1;
        continue;
      }
      if (character === "[") {
        links.push(start + index - (line[index - 1] === "!" ? 1 : 0));
        index++;
        continue;
      }
      if (character === "]" && links.length > 0) {
        const opened = links.pop() as number;
        const next = line[index + 1];
        if (next === undefined && finalLine) { propose(opened); index++; continue; }
        if (next === "(") {
          let scan = index + 2;
          while (scan < line.length && line[scan] !== ")") scan += line[scan] === "\\" ? 2 : 1;
          if (line[scan] === ")") { index = scan + 1; continue; }
          if (finalLine) { propose(opened); index = line.length; continue; }
          index++;
          continue;
        }
        index++;
        continue;
      }
      if (character === "*" || character === "_" || character === "~") {
        const run = runLength(line, index, character);
        const previous = index > 0 ? line[index - 1] : "";
        const next = line[index + run] ?? "";
        const flank = flanking(previous, next);
        const strikethrough = character === "~";
        const canOpen = strikethrough ? run === 2 && flank.left : character === "*" ? flank.left : flank.left && (!flank.right || flank.previousPunctuation);
        const canClose = strikethrough ? run === 2 && flank.right : character === "*" ? flank.right : flank.right && (!flank.left || flank.nextPunctuation);
        const closes = canClose && emphasis.some((entry) => entry.marker === character);
        if (!closes) dangle(start + index, run);
        if (closes) {
          let remaining = run;
          while (remaining > 0 && emphasis.length > 0) {
            const top = emphasis[emphasis.length - 1];
            if (top.marker !== character) { emphasis.pop(); continue; }
            const used = Math.min(top.length, remaining);
            top.length -= used;
            remaining -= used;
            if (top.length === 0) emphasis.pop();
          }
        } else if (canOpen) emphasis.push({ marker: character, length: run });
        index += run;
        continue;
      }
      index++;
    }
  }

  if (display !== null) propose(display);
  if (environments.length > 0) propose(environments[0].start);
  if (links.length > 0) propose(links[0]);
  return { fence, truncate: candidate, codeTicks, emphasis };
}

function dropPartialFileTag(text: string) {
  const opening = text.lastIndexOf("<");
  if (opening < 0) return text;
  const rest = text.slice(opening);
  if (rest.includes(">")) return text;
  return FILE_TAG.startsWith(rest) || rest.startsWith(FILE_TAG) ? text.slice(0, opening) : text;
}

// A header row means nothing until its delimiter row lands, and a half-typed
// row would keep changing its column count, so both stay hidden.
function dropUnstableTable(text: string) {
  const lines = text.split("\n");
  const complete = text.endsWith("\n");
  const content = complete ? lines.slice(0, -1) : lines;
  let first = content.length;
  while (first > 0 && !BLANK_LINE.test(content[first - 1])) first--;
  const block = content.slice(first);
  if (block.length === 0 || !TABLE_ROW.test(block[0])) return text;
  const blockStart = content.slice(0, first).reduce((total, line) => total + line.length + 1, 0);
  const settled = block.length > 2 || (block.length === 2 && complete);
  if (!settled || !TABLE_DELIMITER.test(block[1] ?? "")) return text.slice(0, blockStart);
  if (complete) return text;
  return text.slice(0, text.length - (block.at(-1) as string).length);
}

function dropIncompleteMarker(text: string) {
  if (text.endsWith("\n")) return text;
  const start = text.lastIndexOf("\n") + 1;
  return INCOMPLETE_MARKER.test(text.slice(start)) ? text.slice(0, start) : text;
}

function closers(scan: Scan) {
  const backticks = scan.codeTicks > 0 ? "`".repeat(scan.codeTicks) : "";
  const marks = scan.emphasis.map((entry) => entry.marker.repeat(Math.min(entry.length, 3))).reverse().join("");
  return `${backticks}${marks}`;
}

/**
 * Turn the Markdown received so far into the closest complete document, so the
 * renderer can show it immediately and keep showing it the same way as more
 * text arrives.
 */
export function streamingMarkdown(source: string): string {
  let text = source;
  for (let pass = 0; pass < 4; pass++) {
    const scan = scanDocument(text);
    if (scan.fence) return `${text}${text.endsWith("\n") ? "" : "\n"}${scan.fence.indent}${scan.fence.marker}\n`;
    if (scan.truncate !== null) { text = text.slice(0, scan.truncate); continue; }
    const trimmed = dropIncompleteMarker(dropUnstableTable(dropPartialFileTag(text)));
    if (trimmed !== text) { text = trimmed; continue; }
    const suffix = closers(scan);
    return suffix ? `${text.replace(/[ \t]+$/, "")}${suffix}` : text;
  }
  return text;
}
