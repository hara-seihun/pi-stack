// Voice is WebRTC, an audio worklet and a second stream connection: real work
// for the sessions that use it, dead weight in the first paint of an inbox.
// The main app installs this stand-in instead of importing `voice.ts`, so the
// module arrives on the first mic toggle. The Voice and Meet pages import the
// real module directly: there, voice is the reason the page exists.
//
// `create` stays synchronous because callers hold the session and call
// `stop()`, `toggleMute()` and the rest without awaiting anything. Until the
// module lands the stand-in answers for a session that has not started; once
// it lands every call goes straight to the real session.

type VoiceOptions = Parameters<Window["PiRemoteVoice"]["create"]>[0];

let loading: Promise<typeof import("./voice")> | null = null;

/** Starts the download once. */
export function loadVoice() {
  if (!loading) loading = import("./voice");
  return loading;
}

class LazyVoiceSession implements VoiceSession {
  private session: VoiceSession | null = null;
  private stopped = false;
  private muted = false;
  private outputMuted: boolean;

  constructor(private readonly options: VoiceOptions) {
    this.outputMuted = options.outputMuted ?? false;
  }

  get state() { return this.session?.state ?? (this.stopped ? "idle" : "connecting"); }

  async start() {
    const module = await loadVoice();
    // Stopped while the module was in flight: nothing to connect to.
    if (this.stopped) return;
    const session = new module.VoiceSession({ ...this.options, outputMuted: this.outputMuted }) as unknown as VoiceSession;
    this.session = session;
    await session.start();
    if (this.muted) session.toggleMute();
  }

  suspend() { this.session?.suspend(); }

  async stop() {
    this.stopped = true;
    await this.session?.stop();
    this.session = null;
  }

  toggleMute() {
    if (this.session) return this.session.toggleMute();
    this.muted = !this.muted;
    return this.muted;
  }

  hush() { this.session?.hush(); }

  async resumePlayback() { await this.session?.resumePlayback(); }

  setOutputMuted(muted: boolean) {
    this.outputMuted = muted;
    this.session?.setOutputMuted(muted);
  }
}

/** Publishes `window.PiRemoteVoice` without loading the voice module. */
export function installLazyVoice() {
  window.PiRemoteVoice = { create: (options) => new LazyVoiceSession(options) };
}
