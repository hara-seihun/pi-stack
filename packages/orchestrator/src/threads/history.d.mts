export type SessionEntry = Record<string, any>;
export type ThreadHistoryResult<T> = { ok: true; value: T } | { ok: false; error: ThreadHistoryError };
export type ThreadHistoryError = {
  code: "missing" | "io" | "invalid-record" | "oversized-record" | "oversized-index" | "invalid-branch" | "stale-source" | "invalid-descriptor";
  path: string;
  message: string;
  line?: number;
  offset?: number;
  entryId?: string;
  limit?: number;
};
export type HistoryBlockDescriptor = Readonly<{
  index: number;
  type: string;
  displayed: boolean;
  toolCallId?: string;
  name?: string;
  namespace?: string;
}>;
export type RecordDescriptor = Readonly<{
  id: string;
  parentId: string | null;
  type: string;
  offset: number;
  length: number;
  line: number;
  digest: string;
  /** Manager wake input stays hidden; the rest of its turn is visible only when it contains assistant text. */
  monoVisibility?: "hidden" | "visible";
  timestamp?: number | null;
  /** Native custom-data entry discriminator; bodies are not retained. */
  customType?: string;
  /** Native USER identity proven by preceding thread_landed ancestry; absent when unknown. */
  inputId?: string;
}>;
export type MessageRecordDescriptor = RecordDescriptor & Readonly<{
  type: "message" | "custom_message";
  role: string;
  timestamp: number | null;
  blocks: readonly HistoryBlockDescriptor[];
  toolCallIds: readonly string[];
  toolResultId: string | null;
  /** Standalone count; omit paired tool results when constructing a branch transcript. */
  displayedItemCount: number;
  pairedToolResult?: true;
  rootConsent?: boolean;
  questionId?: string;
}>;
export type NativeHistorySource = Readonly<{
  kind: "native-jsonl";
  path: string;
  /** Preserved on append, replaced on rewrite, replacement or cache eviction. */
  generation: string;
  /** Exact file revision; readers become stale after any source modification. */
  revision: string;
  size: number;
  leafId: string | null;
}>;
export type IndexedThreadHistory = Readonly<{
  source: NativeHistorySource;
  /** All active-path records except the session header, in parent-chain order. */
  entries: readonly RecordDescriptor[];
  messages: readonly MessageRecordDescriptor[];
  read(descriptor: RecordDescriptor): ThreadHistoryResult<SessionEntry>;
}>;
export const MAX_HISTORY_RECORD_BYTES: number;
export const MAX_HISTORY_INDEX_BYTES: number;
export const MAX_HISTORY_INDEXES: number;
export type IndexedThreadHistoryOptions = Readonly<{
  /** Annotate manager wake turns without changing native records or standalone display counts. */
  managerWakeVisibility?: boolean;
}>;
export function indexedThreadHistory(path: string, leafId?: string, options?: IndexedThreadHistoryOptions): ThreadHistoryResult<IndexedThreadHistory>;
/** Synchronous projection, with at most three fresh append snapshots; scoped readers expire on return. */
export function withIndexedThreadHistory<T>(path: string, leafId: string | undefined, options: IndexedThreadHistoryOptions | undefined, project: (history: IndexedThreadHistory) => T): ThreadHistoryResult<T>;
export function parseSession(text: string): SessionEntry[];
export function activePath(entries: SessionEntry[], leafId?: string): SessionEntry[];
export function timestampMs(value: unknown): number | undefined;
export function sessionRecords(text: string): { entry: SessionEntry; raw: string; line: number }[];
export function readThreadHistory(path: string, leafId?: string): SessionEntry[];
export function visibleThreadHistory(path: string, leafId?: string): SessionEntry[];
