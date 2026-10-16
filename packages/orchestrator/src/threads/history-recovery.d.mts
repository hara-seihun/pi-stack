import type { NativeHistoryWatermark, ThreadHistoryResult } from "./history.mjs";
export type NativeRecordRecovery = Readonly<{
  offset: number;
  length: number;
  digest: string;
  /** Complete raw JSON record obtained from the authenticated resident native owner, excluding LF. */
  raw: string;
  authority: Readonly<{ kind: "resident-native-session"; reference: string; entryId: string }>;
}>;
export type NativeRecoveryReceipt = Readonly<{
  state: "staged-not-adopted";
  sourcePath: string;
  sourceRevision: string;
  sourceDigest: string;
  quarantinePath: string;
  restoredPath: string;
  restoredDigest: string;
  records: readonly (Omit<NativeRecordRecovery, "raw"> & { recoveredDigest: string; insertedBytes: number })[];
}>;
/** Does not modify the source. Both destinations must be new, private paths explicitly selected
 * by the controller. Every original byte remains in quarantine and also occurs in restored output;
 * only proven missing prefixes are inserted. A source mutation removes the staged outputs.
 * This is not adoption authority: fence all native writers before selecting the restored session. */
export function stageNativeHistoryRecordRecovery(path: string, watermark: NativeHistoryWatermark, records: readonly NativeRecordRecovery[], paths: { quarantinePath: string; restoredPath: string }): ThreadHistoryResult<NativeRecoveryReceipt>;
