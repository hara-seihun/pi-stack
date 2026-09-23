// Optional context files a thread destination offers at thread start.
//
// A destination may name a `contextDir` inside its workspace. Its top-level
// Markdown files are offered in the picker with a measured token count, the
// person checks any number of them, and the chosen files travel verbatim into
// the thread's system prompt on every turn. Nothing is loaded unless chosen.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

export interface ContextFileOffer {
  /** File name inside the context directory, including `.md`. */
  name: string;
  /** o200k_base tokens of the file's current bytes. */
  tokens: number;
  bytes: number;
}

const NAME = /^[^/\\\0]+\.md$/i;
const measurements = new Map<string, { mtimeMs: number; size: number; tokens: number }>();

/** Tokens of the file at `path`, following symlinks; re-measured only when its mtime or size moves. */
export function measureContextFile(path: string): { tokens: number; bytes: number } | null {
  let stat;
  try { stat = statSync(path); } catch { return null; }
  if (!stat.isFile()) return null;
  const cached = measurements.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { tokens: cached.tokens, bytes: stat.size };
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const tokens = countTokens(text);
  measurements.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, tokens });
  return { tokens, bytes: stat.size };
}

/** Top-level `.md` files of `directory`, by name. Symlinks to files count; subdirectories do not. A missing or unreadable directory offers nothing. */
export function listContextFiles(directory: string): ContextFileOffer[] {
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const offers: ContextFileOffer[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (!NAME.test(name)) continue;
    const measured = measureContextFile(join(directory, name));
    if (measured) offers.push({ name, ...measured });
  }
  return offers;
}

/** The requested names, each confirmed to be an offered file of `directory`. */
export function selectContextFiles(directory: string | null, requested: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (requested === undefined || requested === null) return { ok: true, value: [] };
  if (!Array.isArray(requested) || requested.some((name) => typeof name !== "string")) return { ok: false, error: "contextFiles must be a list of file names" };
  const names = [...new Set(requested as string[])];
  if (!names.length) return { ok: true, value: [] };
  if (!directory) return { ok: false, error: "This destination offers no context files" };
  const offered = new Set(listContextFiles(directory).map((offer) => offer.name));
  const missing = names.filter((name) => !offered.has(name));
  if (missing.length) return { ok: false, error: `Unknown context files: ${missing.join(", ")}` };
  return { ok: true, value: names };
}

/** System-prompt text carrying the chosen files whole, read fresh from disk. A file that has gone missing is reported instead of silently dropped. */
export function contextFilesPrompt(directory: string, names: readonly string[]): string {
  if (!names.length) return "";
  const sections = [
    `# Context files chosen for this thread`,
    `The person starting this thread picked these files from ${JSON.stringify(directory)} to be in your context. Each appears here whole, read from disk at the start of every turn, so an edit to the file is live on the next message. Files in that folder that are not listed here were not chosen; read them yourself only if the conversation needs them.`,
  ];
  for (const name of names) {
    const path = join(directory, name);
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      sections.push(`## ${path}\n\nThis chosen file could not be read (${code}). Say so rather than working from recalled or inferred content.`);
      continue;
    }
    sections.push(`## ${path}\n\n${text.trimEnd()}`);
  }
  return sections.join("\n\n");
}
