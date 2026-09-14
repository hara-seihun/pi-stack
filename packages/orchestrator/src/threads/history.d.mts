export type SessionEntry = Record<string, any>;
export function parseSession(text: string): SessionEntry[];
export function activePath(entries: SessionEntry[], leafId?: string): SessionEntry[];
export function timestampMs(value: unknown): number | undefined;
export function sessionRecords(text: string): { entry: SessionEntry; raw: string; line: number }[];
export function readThreadHistory(path: string, leafId?: string): SessionEntry[];
export function visibleThreadHistory(path: string, leafId?: string): SessionEntry[];
