import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { authorityState } from "./authority.js";

export type MarkdownResult<T> = { ok: true; value: T } | { ok: false; error: { code: "unset" | "invalid-folder" | "unavailable"; message: string } };
export type MemoryFolder = { path: string; readme: string; instructions: string };

export function memoryFolder(path: string | undefined): MarkdownResult<MemoryFolder> {
  if (path === undefined) return { ok: false, error: { code: "unset", message: "No authenticated memory folder is configured" } };
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) return { ok: false, error: { code: "invalid-folder", message: "Memory folder must be an absolute path" } };
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) return { ok: false, error: { code: "invalid-folder", message: "Memory folder is not a directory" } };
    const files = ["README.md", "AGENTS.md"].map(name => {
      const target = join(canonical, name);
      if (realpathSync(target) !== target || !statSync(target).isFile() || statSync(target).size > 64 * 1024) throw new Error("Invalid memory pointer file");
      return readFileSync(target, "utf8");
    });
    if (files.some(file => !file.trim())) return { ok: false, error: { code: "invalid-folder", message: "Memory README.md and AGENTS.md must be nonempty" } };
    return { ok: true, value: { path: canonical, readme: files[0]!, instructions: files[1]! } };
  } catch {
    return { ok: false, error: { code: "unavailable", message: "Memory folder pointers could not be read" } };
  }
}

export function memoryFolderPrompt(path: string | undefined, now = Date.now()): MarkdownResult<string> {
  const folder = memoryFolder(path);
  if (!folder.ok) return folder;
  if (existsSync(join(folder.value.path, "FORGET-PENDING.md"))) return { ok: false, error: { code: "unavailable", message: "A durable forget projection is pending; active memory and authority use are fenced until its owner completes it" } };
  const authorityPath = join(folder.value.path, "authority.md");
  let current: string | null = null;
  try {
    if (existsSync(authorityPath)) {
      if (realpathSync(authorityPath) !== authorityPath || statSync(authorityPath).size > 65536) return { ok: false, error: { code: "invalid-folder", message: "Authority head path/size is invalid" } };
      current = readFileSync(authorityPath, "utf8");
    }
  } catch { return { ok: false, error: { code: "unavailable", message: "Current authority head cannot be refreshed" } }; }
  const authority = authorityState(current, now);
  const guidance = authority.state === "active" ? `Current standing authority (${JSON.stringify(authority.head.subject)}, revision ${authority.head.revision}):\n${JSON.stringify(authority.head.policy, null, 2)}` : `${authority.message}. Expanded standing delegation grants none.`;
  return { ok: true, value: `# Markdown memory\n\nAuthenticated memory folder: ${JSON.stringify(folder.value.path)}\n\n${folder.value.instructions}\n\n${folder.value.readme}\n\n${guidance}` };
}

export const MEMORY_FOLDER_README = `# Memory\n\nThis folder is the working memory. Keep facts, decisions, work state, calendar data, delegation and steering in Markdown here, with links from this index. Source records adopted from databases live in records/; their exact versions, provenance, exclusions, consent and disclosure evidence remain intact.\n\n- [Authority](authority.md): stated delegation, spending, disclosure, exclusions, consent and validity dates. If missing, expanded standing authority is unset.\n- [Work](work.md): current work, exact next actions, dependencies and explicit stops.\n- [Calendar](calendar.md): event and subscription data, times and timezones, not a separate UI.\n- [Steering](steering.md): policy source, rationale, evidence, action, visibility, outcome and receipts.\n- [Adopted records](records/README.md): original versions and source identities.\n\nUse the existing action authority for outbound effects and their uncertainty fences. Markdown never substitutes for provider acceptance. The independent disclosure/consent journal remains accountable custody.\n`;
export const MEMORY_FOLDER_AGENTS = `# Use this memory\n\nRead README.md, then only the linked notes needed for the task. Maintain the owning note and its index rather than a second task ledger. At the end of active work write the actual state and next action here, then finish; Kenaznia picks up the work when it next needs doing.\n\nKeep each person's private material in their granted folder. Read access is not disclosure consent. Preserve source attribution, corrections, counterevidence, exclusions and validity dates. Do not infer expanded authority from habits or predictions. Ask only for a person-only fact or a decision left with that person. Record steering even when silent steering is granted.\n\nCalendar events belong to calendar.md and linked data notes. Do not silently shift timezones or event times. Adopted records retain stopped/retracted/superseded status; their existence does not reopen work or renew authority.\n`;
