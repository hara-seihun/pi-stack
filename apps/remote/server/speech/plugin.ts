// A speech engine turns one segment of plain text into a stream of PCM. The
// service around it owns text preparation, segmentation, ordering, encoding
// and HTTP; a plugin owns only its engine's wire protocol and voice catalog.

export type TtsResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

export interface TtsVoice {
  id: string;
  name: string;
  description?: string;
}

export interface TtsSpeechRequest {
  text: string;
  voice: string;
  signal: AbortSignal;
}

/** Signed 16-bit little-endian mono samples, emitted as the engine produces them. */
export interface TtsPcmStream {
  sampleRate: number;
  chunks: AsyncIterable<Uint8Array>;
}

export interface TtsPlugin {
  readonly id: string;
  readonly name: string;
  /** Voice the service selects when a request names none. */
  readonly defaultVoice: string | null;
  /** Longest text one `speak` call accepts; longer messages are split on line breaks first. */
  readonly maxSegmentChars: number;
  voices(): Promise<TtsResult<TtsVoice[]>>;
  /** Resolves once the engine has accepted the segment; audio then streams. */
  speak(request: TtsSpeechRequest): Promise<TtsResult<TtsPcmStream>>;
}

export interface TtsEngineConfig {
  id: string;
  plugin: string;
  name?: string;
  options?: Record<string, unknown>;
}

export type TtsPluginFactory = (config: TtsEngineConfig) => TtsPlugin;
