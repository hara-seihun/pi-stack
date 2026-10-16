import type { Buffer } from "node:buffer";

export type SessionWriterErrorCode =
  | "SESSION_WRITER_CONFIGURATION" | "SESSION_WRITER_PLATFORM"
  | "SESSION_WRITER_DIRECTORY" | "SESSION_WRITER_BUSY" | "SESSION_WRITER_LOCK"
  | "SESSION_WRITER_RELEASED" | "SESSION_WRITER_POISONED" | "SESSION_WRITER_RELEASE"
  | "SESSION_WRITER_SHORT_WRITE" | "SESSION_WRITER_FRAGMENT" | "SESSION_WRITER_HEADER"
  | "SESSION_WRITER_GRAPH" | "SESSION_WRITER_VERSION" | "SESSION_WRITER_UNOWNED";
export class SessionWriterError extends Error {
  readonly code: SessionWriterErrorCode;
  constructor(code: SessionWriterErrorCode, message: string, cause?: unknown);
}
export type SessionWriterResult<T> = { ok: true; value: T } | { ok: false; error: SessionWriterError };
export interface SessionWriterConfiguration {
  readonly directory: string;
  readonly scope: string;
}
export interface SessionWriterOwner {
  assertOwned(): SessionWriterResult<void>;
  poison(cause: unknown): void;
  release(): SessionWriterResult<void>;
}
export interface SessionWriterDisposable { dispose(): void }
export function acquireSessionWriter(config: SessionWriterConfiguration & { readonly identity: string }): SessionWriterResult<SessionWriterOwner>;
export function requireSessionWriter<T>(result: SessionWriterResult<T>): T;
export function withSessionWriterConfiguration<T>(config: SessionWriterConfiguration, callback: () => T): T;
export function sessionWriterConfiguration(): Readonly<{ directory: string | undefined; scope: string | undefined }>;
export function trackSessionWriter(manager: SessionWriterDisposable): void;
export function withSessionWriterScope<T>(callback: () => T | Promise<T>, retain: (manager: SessionWriterDisposable) => boolean): Promise<T>;
export function writeSessionBytes(fd: number, data: string, io: {
  write(fd: number, bytes: Buffer, offset: number, length: number): number;
  sync(fd: number): void;
}): void;
