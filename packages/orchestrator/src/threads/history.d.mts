export type SessionEntry = Record<string, any>;
export type ThreadHistoryResult<T> = { ok: true; value: T } | { ok: false; error: ThreadHistoryError };
export type ThreadHistoryError = {
  code: "missing" | "io" | "invalid-record" | "oversized-record" | "oversized-index" | "invalid-branch" | "stale-source" | "invalid-descriptor" | "invalid-watermark";
  path: string;
  message: string;
  line?: number;
  offset?: number;
  entryId?: string;
  limit?: number;
  /** Exact raw line evidence; no record body or engine parser snippet is disclosed. */
  length?: number;
  digest?: string;
  closed?: boolean;
  syntax?: "utf8" | "json";
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
  /** Manager quiet turns are hidden without changing native records or display counts. */
  monoVisibility?: "hidden" | "visible";
  timestamp?: number | null;
  /** Native custom-data entry discriminator; bodies are not retained. */
  customType?: string;
  /** Native USER identity proven by preceding thread_landed ancestry; absent when unknown. */
  inputId?: string;
  /** Origin owned by the native input receipt or authenticated controller ledger. */
  inputOrigin?: "human" | "machine";
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
  /** Presentation options have their own identity; they never rewrite native source identity. */
  presentationRevision: string;
  /** All active-path records except the session header, in parent-chain order. */
  entries: readonly RecordDescriptor[];
  messages: readonly MessageRecordDescriptor[];
  read(descriptor: RecordDescriptor): ThreadHistoryResult<SessionEntry>;
}>;
export const MAX_HISTORY_RECORD_BYTES: number;
export const MAX_HISTORY_INDEX_BYTES: number;
export const MAX_HISTORY_INDEXES: number;
export type IndexedThreadHistoryOptions = Readonly<{
  /** Annotate manager wake and exact silent-sentinel turns. */
  managerWakeVisibility?: boolean;
  /** Authenticated controller classifications for inputs written before native origin receipts. */
  inputOrigins?: Readonly<Record<string, "human" | "machine">>;
}>;
export function indexedThreadHistory(path: string, leafId?: string, options?: IndexedThreadHistoryOptions): ThreadHistoryResult<IndexedThreadHistory>;
/** Synchronous projection, with at most three fresh append snapshots; scoped readers expire on return. */
export function withIndexedThreadHistory<T>(path: string, leafId: string | undefined, options: IndexedThreadHistoryOptions | undefined, project: (history: IndexedThreadHistory) => T): ThreadHistoryResult<T>;
export type NativeHistoryWatermark = Readonly<{
  kind: "native-jsonl-watermark";
  version: 1;
  revision: string;
  /** Captured file size; an incomplete tail after closedOffset is excluded from the proof. */
  size: number;
  device: string;
  inode: string;
  /** SHA256 of every byte through closedOffset, including record separators. */
  prefixDigest: string;
  lastOffset: number;
  lastLength: number;
  lastLine: number;
  /** SHA256 of the last nonblank complete raw line, excluding its LF. */
  lastDigest: string;
  closedOffset: number;
  nextLine: number;
}>;
export type NativeHistoryLineDescriptor = Readonly<{ offset: number; length: number; line: number; digest: string }>;
export type NativeHistorySuffixRecord =
  | { kind: "record"; descriptor: NativeHistoryLineDescriptor; entry: SessionEntry }
  | { kind: "uncertain"; descriptor: NativeHistoryLineDescriptor; error: ThreadHistoryError };
/** Metadata-only fixed byte-prefix scan; no historical body decoding or record-size limit. */
export function captureNativeHistoryWatermark(path: string): ThreadHistoryResult<NativeHistoryWatermark>;
/** Complete new lines only. Project must consume the iterable synchronously; commit effects only on success.
 * Prefix and boundary proofs detect edits/replacement while allowing append. Oversized/invalid new lines
 * yield per-record uncertainty without replay or preventing observation of later complete records. */
export function withNativeHistorySuffix<T>(path: string, watermark: NativeHistoryWatermark, project: (records: Iterable<NativeHistorySuffixRecord>) => T): ThreadHistoryResult<{ value: T; watermark: NativeHistoryWatermark }>;
export type NativeHistoryQuarantineIntegrity = Readonly<{
  kind: "partial";
  traversal: "stored-order";
  ancestry: "unproven";
  resumeAllowed: false;
  source: Readonly<{ path: string; revision: string; size: number; device: string; inode: string; prefixDigest: string; closedOffset: number }>;
  gaps: readonly (NativeHistoryLineDescriptor & { code: ThreadHistoryError["code"]; message: string })[];
  unclosedTailBytes: number;
}>;
export function quarantinedThreadHistoryPage(path: string, request: { offset: number; limit: number; entryId?: string }): ThreadHistoryResult<{
  entries: SessionEntry[]; nextCursor?: string; integrity: NativeHistoryQuarantineIntegrity;
}>;
export function parseSession(text: string): SessionEntry[];
export function activePath(entries: SessionEntry[], leafId?: string): SessionEntry[];
export function timestampMs(value: unknown): number | undefined;
export function sessionRecords(text: string): { entry: SessionEntry; raw: string; line: number }[];
export function readThreadHistory(path: string, leafId?: string): SessionEntry[];
export function visibleThreadHistory(path: string, leafId?: string): SessionEntry[];
