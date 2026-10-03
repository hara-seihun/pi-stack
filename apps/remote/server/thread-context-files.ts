// Optional context is injected only when a thread explicitly selects it.
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { ThreadStartContext } from "./protocol";

export interface ContextFileSources {
  /** Top-level Markdown folder, if the destination offers one. */
  directory?: string;
  /** Absolute instruction-file candidates, in priority order (workspace, then the owner's home). */
  agentsPaths?: readonly string[];
}

export type ContextFileOffer = ThreadStartContext;

const NAME = /^[^/\\\0]+\.md$/i;
const measurements = new Map<string, { mtimeMs: number; size: number; tokens: number }>();

/** Tokens of the file at `path`, following symlinks; re-measured only when its mtime or size moves. */
export function measureContextFile(path: string): { tokens: number; bytes: number } | null {
  let stat;
  try {
    stat = statSync(path);
    accessSync(path, constants.R_OK);
  } catch { return null; }
  if (!stat.isFile()) return null;
  const cached = measurements.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { tokens: cached.tokens, bytes: stat.size };
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const tokens = countTokens(text);
  measurements.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, tokens });
  return { tokens, bytes: stat.size };
}

/** Offer the first present instruction file; an unreadable workspace file must not select another source. */
function offeredAgentsPath(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    try {
      statSync(path);
      return path;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
  }
  return null;
}

/** Readable top-level Markdown and the destination's instruction file. Symlinks count; subdirectories do not. */
export function listContextFiles(sources: ContextFileSources): ContextFileOffer[] {
  const offers: ContextFileOffer[] = [];
  if (sources.directory) {
    let names: string[];
    try { names = readdirSync(sources.directory); } catch { names = []; }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!NAME.test(name)) continue;
      const measured = measureContextFile(join(sources.directory, name));
      if (measured) offers.push({ name, ...measured });
    }
  }
  const agentsPath = offeredAgentsPath(sources.agentsPaths ?? []);
  if (agentsPath) {
    const measured = measureContextFile(agentsPath);
    if (measured) offers.push({ name: agentsPath, label: "AGENTS.md", ...measured });
  }
  return offers;
}

/** The requested identifiers, each confirmed to be an offered file. */
export function selectContextFiles(sources: ContextFileSources | null, requested: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (requested === undefined || requested === null) return { ok: true, value: [] };
  if (!Array.isArray(requested) || requested.some((name) => typeof name !== "string")) return { ok: false, error: "contextFiles must be a list of file names" };
  const names = [...new Set(requested as string[])];
  if (!names.length) return { ok: true, value: [] };
  if (!sources) return { ok: false, error: "This destination offers no context files" };
  const offered = new Set(listContextFiles(sources).map((offer) => offer.name));
  const missing = names.filter((name) => !offered.has(name));
  if (missing.length) return { ok: false, error: `Unknown context files: ${missing.join(", ")}` };
  return { ok: true, value: names };
}

function contextFilePath(sources: ContextFileSources | null, name: string): string | null {
  if (isAbsolute(name) && sources?.agentsPaths?.includes(name)) return name;
  return sources?.directory && NAME.test(name) ? join(sources.directory, name) : null;
}

/** Chosen files whole, read fresh each turn. Missing choices are reported, never replaced with a different file. */
export function contextFilesPrompt(sources: ContextFileSources | null, names: readonly string[]): string {
  if (!names.length) return "";
  const sections = [
    `# Context files chosen for this thread`,
    `The person starting this thread picked the files listed below to be in your context. Each appears here whole, read from disk at the start of every turn, so an edit to the file is live on the next message. Other files were not chosen; read them yourself only if the conversation needs them.`,
  ];
  for (const name of names) {
    const path = contextFilePath(sources, name);
    if (!path) {
      sections.push(`## ${name}\n\nThis chosen file is no longer available from this destination. Say so rather than working from recalled or inferred content.`);
      continue;
    }
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      sections.push(`## ${path}\n\nThis chosen file could not be read (${code}). Say so rather than working from recalled or inferred content.`);
      continue;
    }
    sections.push(`## ${path}\n\n${text}`);
  }
  return sections.join("\n\n");
}
