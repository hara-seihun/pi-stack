#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { LifeClient, LifeDue, LifeEntityInput, LifeImportReceipt, LifeProvenance, LifeResult } from "../packages/kenan-memory/src/life-contract.js";

type ImportError = "invalid-options" | "source-unavailable" | "invalid-source" | "too-many-items";
type Result<T> = { ok: true; value: T } | { ok: false; error: ImportError; message: string };
type ImportEntry = { id: string; entity: LifeEntityInput };
type SourceItem = { needsPerson: boolean; title: string; original: string; start: number; end: number };
export type ImportOptions = { source: string; needsHeading: string };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function validOptions(options: ImportOptions): boolean {
  return isAbsolute(options.source) && options.source.indexOf("\0") === -1 && options.needsHeading.trim() === options.needsHeading && !!options.needsHeading && !/[\r\n]/.test(options.needsHeading);
}

function explicitDue(text: string): LifeDue {
  const matches = [...text.matchAll(/\bdue:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))(?![\w.+:-])/gi)];
  if (matches.length !== 1) return null;
  const at = matches[0]![1]!;
  if (!Number.isFinite(Date.parse(at))) return null;
  const day = at.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return { at: new Date(at).toISOString(), timeZone: "UTC" };
}

export function markdownImportEntries(bytes: Uint8Array, options: ImportOptions, observedAt: string): Result<{ fingerprint: string; entries: ImportEntry[] }> {
  if (!validOptions(options) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) return { ok: false, error: "invalid-options", message: "An absolute source, nonempty section heading, and observation timestamp are required" };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, error: "invalid-source", message: "The Markdown source is not valid UTF-8" }; }
  const fingerprint = hash(bytes);
  const raw = text.match(/[^\n]*(?:\n|$)/g)!.filter((line, index, lines) => line !== "" || index !== lines.length - 1);
  const lines = raw.map((line, index) => line.replace(/\r?\n$/, "").replace(index === 0 ? /^\uFEFF/ : /$^/, ""));
  const items: SourceItem[] = [];
  let needsPerson = false;
  let fence: { character: string; length: number } | null = null;
  const bullet = /^(\s*)(?:[-+*]|\d+[.)])\s+(.*)$/;
  const checkbox = /^\[([ xX])\](?:\s+(.*)|\s*)$/;
  const heading = /^ {0,3}(#{1,6})[\t ]+(.+?)(?:[\t ]+#+[\t ]*)?$/;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenced = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenced && fenced[1]![0] === fence.character && fenced[1]!.length >= fence.length && /^ {0,3}(?:`+|~+)[\t ]*$/.test(line)) fence = null;
      continue;
    }
    if (fenced) { fence = { character: fenced[1]![0]!, length: fenced[1]!.length }; continue; }
    const section = heading.exec(line);
    if (section) {
      if (section[1]!.length <= 2) needsPerson = section[1]!.length === 2 && section[2] === options.needsHeading;
      continue;
    }
    if (!line.trim() || /^\s*(?:([-*_])\s*){3,}$/.test(line)) continue;
    const listed = bullet.exec(line);
    const checked = listed ? checkbox.exec(listed[2]!) : null;
    const start = index;
    if (listed) {
      while (index + 1 < lines.length) {
        let following = index + 1;
        while (following < lines.length && !lines[following]!.trim()) following++;
        if (following === lines.length) break;
        const next = lines[following]!;
        if (bullet.test(next) || heading.test(next) || /^ {0,3}(`{3,}|~{3,})/.test(next)) break;
        const indentation = /^\s*/.exec(next)![0].length;
        if (indentation <= listed[1]!.length) break;
        index = following;
      }
      if (checked && checked[1] !== " ") continue;
      if (!needsPerson && !checked) continue;
    } else {
      if (!needsPerson) continue;
      while (index + 1 < lines.length && lines[index + 1]!.trim() && !bullet.test(lines[index + 1]!) && !heading.test(lines[index + 1]!) && !/^ {0,3}(`{3,}|~{3,})/.test(lines[index + 1]!)) index++;
    }
    const titleFirst = listed ? checked ? checked[2] ?? "" : listed[2]! : line;
    const title = [titleFirst, ...lines.slice(start + 1, index + 1)].map(value => value.trim()).join("\n").trim();
    if (!title) continue;
    const original = raw.slice(start, index + 1).join("");
    if (title.length > 100_000 || original.length > 90_000) return { ok: false, error: "invalid-source", message: `Source item at line ${start + 1} exceeds the life evidence limit` };
    items.push({ needsPerson, title, original, start: start + 1, end: index + 1 });
  }
  const entries: ImportEntry[] = [];
  for (const item of items) {
    const anchor = item.start === item.end ? `#L${item.start}` : `#L${item.start}-L${item.end}`;
    const id = `markdown:${hash(`${options.source}\0${item.start}\0${item.end}`)}`;
    const provenance: LifeProvenance = {
      factClass: "stated", confidence: null,
      source: { actor: null, locator: `${options.source}${anchor}`, observedAt },
      evidence: [{ kind: "source", id: `sha256:${fingerprint}`, relation: `Original Markdown (${options.source}${anchor}):\n${item.original}` }],
      counterevidence: [], validFrom: null, validUntil: null,
    };
    const due = explicitDue(item.title);
    entries.push({ id, entity: {
      kind: "commitment", title: item.title, provenance, state: item.needsPerson ? "waiting" : "proposed",
      parties: [], authority: null, origin: item.original, due, acceptance: item.title, dependencies: [],
      owner: { kind: "kenan" }, nextAction: null,
      waiting: item.needsPerson ? { for: "person", detail: `Source section: ${options.needsHeading}` } : null, goalId: null,
    } });
    if (item.needsPerson) entries.push({ id: `${id}:needs-you`, entity: {
      kind: "needs-you", title: item.title, provenance, state: "open", reason: "person-only-action",
      consequence: null, recommendation: null, requiredBy: due, commitmentId: id, questionId: null,
    } });
  }
  if (entries.length > 1000) return { ok: false, error: "too-many-items", message: "The source exceeds the atomic import limit of 1000 life entities" };
  return { ok: true, value: { fingerprint, entries } };
}

export async function importMarkdown(options: ImportOptions, client: LifeClient, observedAt: string): Promise<Result<LifeImportReceipt> | LifeResult<LifeImportReceipt>> {
  if (!validOptions(options)) return { ok: false, error: "invalid-options", message: "Use --source /absolute/file --needs-heading 'Needs NAME'" };
  let source: string;
  try { source = await realpath(options.source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: "source-unavailable", message: "Cannot resolve the source file" };
    source = resolve(options.source);
  }
  const receipt = await client.request<LifeImportReceipt>({ operation: "import-receipt", target: { scope: "self" }, source });
  if (receipt.ok || receipt.error !== "not-found") return receipt;
  let bytes: Buffer;
  try { bytes = await readFile(source); }
  catch { return { ok: false, error: "source-unavailable", message: "Cannot read the source file" }; }
  const parsed = markdownImportEntries(bytes, { ...options, source }, observedAt);
  if (!parsed.ok) return parsed;
  return client.request<LifeImportReceipt>({ operation: "import-entities", target: { scope: "self" }, source, ...parsed.value });
}

export function importArguments(args: string[]): Result<ImportOptions> {
  const options: Partial<ImportOptions> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value || value.startsWith("--")) return { ok: false, error: "invalid-options", message: "Both --source and --needs-heading require a value" };
    if (flag === "--source" && options.source === undefined) options.source = value;
    else if (flag === "--needs-heading" && options.needsHeading === undefined) options.needsHeading = value;
    else return { ok: false, error: "invalid-options", message: "Only --source and --needs-heading are accepted, once each; identity is authenticated, not a CLI argument" };
  }
  if (options.source === undefined || options.needsHeading === undefined || !validOptions(options as ImportOptions)) return { ok: false, error: "invalid-options", message: "Use --source /absolute/file --needs-heading 'Needs NAME'" };
  return { ok: true, value: options as ImportOptions };
}

if (import.meta.main) {
  if (process.argv.slice(2).join(" ") === "--help") console.log("Usage: bun scripts/life-import.ts --source /absolute/file --needs-heading 'Needs NAME'\nRead-only source; one atomic, one-time import into the authenticated person's life store. Prints the receipt, never item text. Requires the current memory session or a supervised local identity.");
  else {
    const options = importArguments(process.argv.slice(2));
    if (!options.ok) { console.error(JSON.stringify(options)); process.exitCode = 64; }
    else {
      const { lifeClient } = await import("../packages/kenan-memory/src/life-client.js");
      const result = await importMarkdown(options.value, lifeClient(), new Date().toISOString());
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
  }
}
