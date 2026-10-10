import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { ForgetMode, MemoryItem } from "./contract.js";
export type ForgetProjectionResult<T> = { ok: true; value: T } | { ok: false; error: "unavailable"; message: string };
type Fence = { version: 1; id: string; ids: string[]; mode: ForgetMode; texts: string[]; subject: string; invalidated: string[]; signature: string };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const pendingName = "FORGET-PENDING.md", forgottenName = "FORGOTTEN.md";
const json = (text: string) => [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
const note = (title: string, value: unknown) => `# ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const signature = (fence: Pick<Fence, "version" | "id" | "ids" | "mode" | "texts" | "subject" | "invalidated">, key: string) => createHmac("sha256", key).update(JSON.stringify([fence.version, fence.id, fence.ids, fence.mode, fence.texts, fence.subject, fence.invalidated])).digest("hex");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function replace(file: string, before: string | null, after: string) {
  if (before === null ? existsSync(file) : !existsSync(file) || readFileSync(file, "utf8") !== before) throw new Error("Concurrent memory note change");
  const temp = `${file}.${randomUUID()}.tmp`, fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, after); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (before === null ? existsSync(file) : readFileSync(file, "utf8") !== before) throw new Error("Concurrent memory note change");
    renameSync(temp, file);
    const dir = openSync(join(file, ".."), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function memoryUseFenced(folder: string | undefined): boolean { return folder !== undefined && existsSync(join(folder, pendingName)); }
export function forgottenIds(folder: string): string[] {
  const path = join(folder, forgottenName); if (!existsSync(path)) return [];
  const value = json(readFileSync(path, "utf8"))[0];
  if (!object(value) || value.version !== 1 || !Array.isArray(value.ids) || value.ids.some((id: unknown) => typeof id !== "string")) throw new Error("Forget exclusion note is invalid");
  return value.ids;
}
function files(folder: string): Map<string, string> {
  const output = new Map<string, string>(); let bytes = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Memory projection contains a redirect");
      if (stat.isDirectory()) { walk(file); continue; }
      if (!name.endsWith(".md") || [pendingName, forgottenName].includes(name)) continue;
      if (!stat.isFile() || output.size >= 10000 || stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) throw new Error("Memory projection exceeds its explicit scan bound");
      output.set(file, readFileSync(file, "utf8"));
    }
  };
  walk(folder); return output;
}
export function projectionInvalidation(folders: readonly { path: string; subject: string }[], ids: readonly string[]): string[] {
  const invalid = new Set(ids), nodes = folders.flatMap(folder => [...files(folder.path).values()].flatMap(text => json(text).flatMap(value => { const node = projectionNode(value, folder.subject); return node ? [node] : []; })));
  for (const folder of folders) for (const id of forgottenIds(folder.path)) invalid.add(id);
  let changed = true;
  while (changed) { changed = false; for (const node of nodes) if (node.derived && node.dependencies.some(id => invalid.has(id)) && !invalid.has(node.id)) { invalid.add(node.id); changed = true; } }
  return [...invalid].sort();
}
export function projectionNode(value: unknown, folderSubject?: string): { id: string; derived: boolean; dependencies: string[] } | null {
  if (!object(value)) return null;
  const actual = value.format === "markdown-authority-v1" ? value.policy : object(value.value) ? value.value : value;
  const provenance = actual?.provenance;
  const id = typeof value.id === "string" ? value.id : value.format === "markdown-authority-v1" && typeof value.subject === "string" ? `authority:${value.subject}` : typeof actual?.id === "string" ? actual.id : null;
  if (!id) return null;
  const subject = typeof value.subject === "string" ? value.subject : folderSubject;
  const scoped = !Object.hasOwn(value, "body") && object(provenance) && subject !== undefined;
  const evidence = Array.isArray(provenance?.evidence) ? provenance.evidence : Array.isArray(actual?.evidence) ? actual.evidence : [];
  return { id: scoped ? `note:${subject}:${id}` : id, derived: provenance?.factClass === "derived" || provenance?.factClass === "hypothesis", dependencies: evidence.filter((item: any) => object(item) && typeof item.id === "string").map((item: any) => item.kind === "life" && subject !== undefined ? `note:${typeof item.subject === "string" ? item.subject : subject}:${item.id}` : item.id) };
}
function scrub(folder: string, fence: Fence) {
  const contents = files(folder), invalid = new Set([...forgottenIds(folder), ...fence.ids, ...fence.invalidated]);
  const nodes = [...contents].map(([file, text]) => ({ file, nodes: json(text).flatMap(value => { const node = projectionNode(value, fence.subject); return node ? [node] : []; }) }));
  let changed = true;
  while (changed) { changed = false; for (const { nodes: list } of nodes) for (const node of list) if (node.derived && node.dependencies.some(id => invalid.has(id)) && !invalid.has(node.id)) { invalid.add(node.id); changed = true; } }
  const removed = new Set(nodes.filter(({ nodes: list }) => list.some(node => invalid.has(node.id))).map(item => item.file));
  const names = [...removed].map(file => file.slice(folder.length + 1));
  for (const [file, before] of contents) {
    if (removed.has(file)) {
      if (readFileSync(file, "utf8") !== before) throw new Error("Concurrent forgotten record update");
      unlinkSync(file); continue;
    }
    const blocks = json(before);
    const independentStatedAuthority = blocks.some(value => object(value) && value.format === "markdown-authority-v1" && value.policy?.provenance?.factClass === "stated");
    if (independentStatedAuthority) continue;
    const paragraphs = before.split(/\n\s*\n/);
    const after = paragraphs.filter(paragraph => !fence.texts.some(text => text.length > 0 && paragraph.includes(text))).map(paragraph => paragraph.split("\n").filter(line => !names.some(name => line.includes(name))).join("\n")).filter(Boolean).join("\n\n") + "\n";
    if (after !== before) replace(file, before, after);
  }
  const exclusionPath = join(folder, forgottenName), previous = existsSync(exclusionPath) ? readFileSync(exclusionPath, "utf8") : null;
  replace(exclusionPath, previous, note("Active memory exclusions", { version: 1, ids: [...invalid].sort() }));
}
function readFence(folder: string, key: string): Fence | null {
  const file = join(folder, pendingName); if (!existsSync(file)) return null;
  const fence = json(readFileSync(file, "utf8"))[0];
  if (!object(fence) || fence.version !== 1 || typeof fence.id !== "string" || !["delete", "stop-using"].includes(fence.mode) || !Array.isArray(fence.ids) || !Array.isArray(fence.texts) || typeof fence.subject !== "string" || !Array.isArray(fence.invalidated) || [...fence.ids, ...fence.texts, ...fence.invalidated].some(value => typeof value !== "string")) throw new Error("Pending forget fence is invalid");
  if (typeof fence.signature !== "string" || !/^[a-f0-9]{64}$/.test(fence.signature) || !timingSafeEqual(Buffer.from(fence.signature, "hex"), Buffer.from(signature(fence as Fence, key), "hex"))) throw new Error("Forget fence was not issued by authenticated custody");
  return fence as Fence;
}
export function projectForget<T>(options: { folders: readonly { path: string; subject: string }[]; items: readonly MemoryItem[]; invalidated: readonly string[]; metadataReadable: boolean; mode: ForgetMode; signatureKey: string; includeText(item: MemoryItem): boolean; commit(ids: string[], mode: ForgetMode): T }): ForgetProjectionResult<T> {
  try {
    const folders = [...new Set(options.folders.map(folder => folder.path))].sort();
    for (const folder of folders) if (realpathSync(folder) !== folder || !lstatSync(folder).isDirectory()) throw new Error("Forget folder is not canonical");
    const ids = options.items.map(item => item.id).sort(), id = digest(JSON.stringify([ids, options.mode]));
    for (const folder of folders) {
      const subject = options.folders.find(owner => owner.path === folder)!.subject;
      const visibleIds = new Set(ids);
      if (options.metadataReadable) for (const text of files(folder).values()) for (const value of json(text)) {
        const node = projectionNode(value, subject);
        if (node) { visibleIds.add(node.id); for (const dependency of node.dependencies) visibleIds.add(dependency); }
      }
      const base = { version: 1 as const, id, ids, mode: options.mode, subject, invalidated: options.invalidated.filter(value => visibleIds.has(value)), texts: options.items.filter(item => options.includeText(item) && item.about.every(person => person === subject)).map(item => item.text) };
      const fence: Fence = { ...base, signature: signature(base, options.signatureKey) };
      const prior = readFence(folder, options.signatureKey);
      if (prior && prior.id !== id) throw new Error("Another forget projection owns this folder");
      replace(join(folder, pendingName), prior ? readFileSync(join(folder, pendingName), "utf8") : null, note("Forget projection pending — active use is fenced", fence));
    }
    const result = options.commit(ids, options.mode);
    for (const folder of folders) scrub(folder, readFence(folder, options.signatureKey)!);
    for (const folder of folders) unlinkSync(join(folder, pendingName));
    return { ok: true, value: result };
  } catch { return { ok: false, error: "unavailable", message: "Forget projection is pending; active memory/authority use remains fenced until custody recovery completes" }; }
}
export function recoverForget(folder: string, signatureKey: string, commit: (ids: string[], mode: ForgetMode) => unknown): ForgetProjectionResult<void> {
  try {
    const fence = readFence(folder, signatureKey); if (!fence) return { ok: true, value: undefined };
    commit(fence.ids, fence.mode); scrub(folder, fence); unlinkSync(join(folder, pendingName));
    return { ok: true, value: undefined };
  } catch { return { ok: false, error: "unavailable", message: "Pending forget projection recovery could not complete; active use stays fenced" }; }
}
