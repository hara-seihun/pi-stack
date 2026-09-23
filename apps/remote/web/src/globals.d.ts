declare const __PI_REMOTE_REVISION__: string;

interface MarkdownRenderer {
  render(source: string, env?: Record<string, unknown>): string;
  use(plugin: unknown, options: unknown): MarkdownRenderer;
  renderer: {
    rules: Record<string, ((tokens: any[], index: number, options: any, env: any, renderer: any) => string) | undefined>;
  };
}

interface Window {
  markdownit(options: Record<string, unknown>): MarkdownRenderer;
  texmath: unknown;
  /** Present only after `math-engine.ts` has loaded KaTeX on the first formula. */
  katex?: { renderToString(tex: string, options: { displayMode?: boolean }): string };
  normalizeLatexDelimiters(source: string): string;
  PiRemotePerson: {
    get(): string;
    set(user: string): void;
    header: string;
    session(): string;
    acceptSession(user: string, session: string): void;
    clearSession(session?: string): void;
    headers(initial?: HeadersInit, includeSession?: boolean): Headers;
    href(path: string): string;
  };
  PiRemoteVoice: {
    create(options: {
      sessionId: string;
      request?: import("./meet/transport").MeetRequest;
      input?: MediaStream;
      onOutput?(stream: MediaStream): void;
      meetingContext?(): string;
      handoffContext?(): Promise<void>;
      outputMuted?: boolean;
      onVoiceControl?(state: import("../../server/meet/protocol").MeetVoiceControl): void;
      onFragment?(fragment: { id: string; role: "user" | "assistant"; text: string; voiceSessionId: string; startMs: number; endMs: number; startedAt: number }): void;
      onPlayback?(state: "playing" | "blocked" | "muted" | "stopped"): void;
      onState(state: string, detail?: string): void;
      onNotice(message: string): void;
      onTranscript?(role: string, text: string): void;
    }): VoiceSession;
  };
  /** Installed by the app shell's back handling; true when the client moved somewhere, false when the shell should background the app. */
  PiRemoteBack?: () => boolean;
  KenanRemote?: {
    enabled: boolean;
    getState(): Promise<any>;
    select(options: { id: string; user: string }): Promise<any>;
    resolveApiUrl(path: string): string;
  };
  Capacitor?: any;
}

interface VoiceSession {
  state: string;
  start(): Promise<void>;
  suspend(): void;
  stop(): Promise<void>;
  toggleMute(): boolean;
  hush(): void;
  resumePlayback(): Promise<void>;
  setOutputMuted(muted: boolean): void;
}
