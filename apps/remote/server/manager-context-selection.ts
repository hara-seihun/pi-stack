import type { Result, Thread } from "pi-orchestrator/api";
import { listContextFiles, type ContextFileSources } from "./thread-context-files";

export type ThreadContextSelection = { mode: "all" | "manual"; files: string[] };

export function storedThreadContextSelection(metadata: Thread["metadata"]): ThreadContextSelection | undefined {
  if (!Array.isArray(metadata?.contextFiles) || !metadata.contextFiles.every(file => typeof file === "string")) return undefined;
  if (metadata.manager === true) {
    if (metadata.contextSelection !== "all" && metadata.contextSelection !== "manual") return undefined;
    return { mode: metadata.contextSelection, files: [...metadata.contextFiles] };
  }
  return { mode: "manual", files: [...metadata.contextFiles] };
}

export function reconcileThreadContextSelection(thread: Pick<Thread, "metadata">, sources: ContextFileSources | null,
  persist: (metadata: { contextSelection: "all"; contextFiles: string[] }) => Result<Pick<Thread, "metadata">>): Result<ThreadContextSelection> {
  if (thread.metadata?.manager !== true) {
    const files = Array.isArray(thread.metadata?.contextFiles) ? thread.metadata.contextFiles.filter((name): name is string => typeof name === "string") : [];
    return { ok: true, value: { mode: "manual", files } };
  }
  const files = sources ? [...new Set(listContextFiles(sources).map(offer => offer.name))] : [];
  if (thread.metadata.contextSelection !== "all" || JSON.stringify(thread.metadata.contextFiles) !== JSON.stringify(files)) {
    const saved = persist({ contextSelection: "all", contextFiles: files });
    if (!saved.ok) return saved;
  }
  return { ok: true, value: { mode: "all", files } };
}
