import { VoiceSession } from "../voice";
import { API } from "../../../server/api";
import { meetPath, type MeetJoined, type MeetSnapshot, type MeetVoiceControl, type MeetVoiceWake } from "../../../server/meet/protocol";
import { pendingWork, VoiceDemand } from "./voice-demand";
import { avatarStream, MeetMedia, type MeetMediaSource } from "./media";
import { MeetBrowser } from "./browser";
import { MeetRoom, post } from "./room";
import { MeetTranscription } from "./transcription";
import { meetJson, type MeetRequest } from "./transport";
import { MeetVoicePlayout } from "./voice-playout";

export type { MeetRequest } from "./transport";
declare const __MEET_AVATAR__: string;

export interface MeetAdapterOptions {
  request: MeetRequest;
  namespace: string;
  eventKey: string;
  name?: string;
  container: HTMLElement;
  onState?(state: MeetAdapterState): void;
  onBrowserStream?(stream: MediaStream | null): void;
  onAudioDiagnostic?(data: unknown): void;
}

export interface MeetAdapterState {
  status: "connecting" | "live" | "suspended" | "closing" | "closed" | "error";
  voice: string;
  playback: string;
  notice: string;
  inputSource: "mixed";
  room: MeetSnapshot;
}

export interface MeetAdapterRecovery {
  readonly state: MeetAdapterState;
  suspend(): Promise<void>;
  close(): Promise<void>;
  retryTranscription(): Promise<void>;
}

export class MeetAdapterStartError extends Error {
  constructor(cause: unknown, readonly recovery: MeetAdapterRecovery) {
    super(String(cause instanceof Error ? cause.message : cause), { cause });
    this.name = "MeetAdapterStartError";
  }
}

export interface MeetAdapter extends MeetAdapterRecovery {
  readonly cameraStream: MediaStream;
  readonly browserStream: MediaStream | null;
  setMuted(muted: boolean): Promise<void>;
  shareBrowser(url: string): Promise<void>;
  stopSharing(): Promise<void>;
  resumePlayback(): Promise<void>;
}

export async function startMeetAdapter(options: MeetAdapterOptions): Promise<MeetAdapter> {
  if (!options.namespace.trim() || !options.eventKey.trim()) throw new Error("An external meeting needs a namespace and stable eventKey");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Recall mixed-audio capture is unavailable in this page");
  const input = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
  });
  let room: MeetRoom | null = null;
  let media: MeetMedia | null = null;
  let transcription: MeetTranscription | null = null;
  let browser: MeetBrowser | null = null;
  let voice: VoiceSession | null = null;
  let demand: VoiceDemand | null = null;
  let avatar: Awaited<ReturnType<typeof avatarStream>> | null = null;
  let playout: MeetVoicePlayout | null = null;
  let closing: Promise<void> | null = null;
  let suspending: Promise<void> | null = null;
  let voiceStopping: Promise<void> | null = null;
  let suspended = false;
  let running = false;
  let roomFailure = "";
  let state: MeetAdapterState;
  const stage = document.createElement("div");
  stage.style.cssText = "width:100%;height:100%;display:grid;place-items:center;background:#0b111c;overflow:hidden";
  const video = document.createElement("video");
  video.autoplay = true; video.muted = true; video.playsInline = true;
  video.setAttribute("aria-label", "PiStack Meet camera dashboard");
  video.style.cssText = "display:block;width:min(100%,100vh);height:auto;max-height:100%;aspect-ratio:1;object-fit:contain";
  stage.append(video);
  const outputAudio = document.createElement("audio");
  outputAudio.autoplay = true;
  outputAudio.setAttribute("playsinline", "");
  stage.append(outputAudio);

  const update = (patch: Partial<MeetAdapterState> = {}) => {
    state = { ...state, ...patch, room: room!.snapshot };
    options.onState?.(state);
  };
  const notice = (message: string) => update({ notice: message });
  const meetingContext = () => {
    const current = room!.snapshot;
    return [
      current.platformTranscript
        ? "External meeting audio source: Mixed meeting audio. The meeting platform supplies the speaker-labelled transcript."
        : "External meeting audio source: Mixed meeting audio. This is one mixed feed, not identified individual speakers.",
      `Kenan's outgoing voice is ${current.voiceMuted ? "muted" : "unmuted"}.`,
      current.browser ? `Shared browser: ${current.browser.url}` : "No browser is being shared.",
    ].join("\n");
  };
  // Voice was closed when this line was said, so nobody heard it but the transcript. Pi decides whether it asks anything of Kenan.
  const handMention = async (wake: MeetVoiceWake) => {
    try {
      await meetJson(options.request, API.sessionPrompt.path({ sessionId: room!.snapshot.sessionId }), post({
        requestId: crypto.randomUUID(), delivery: "steer", includeMeetingImages: true,
        text: ["Meeting mention", meetingContext(),
          `${wake.speaker} said your name while your voice connection was closed, so no one has answered yet: "${wake.text}"`,
          "If it asks something of you, such as unmuting or doing some work, handle it as you would a Voice handoff. The transcript below can also hold earlier requests to you that nobody heard; handle every one still unanswered, not only this line. If it only mentions you in passing, end your turn without acting."].join("\n\n"),
      }));
    } catch (cause) { notice(`Mention handoff failed: ${String(cause instanceof Error ? cause.message : cause)}`); }
  };
  const reconcile = (snapshot: MeetSnapshot) => {
    if (suspended) return;
    voice?.setOutputMuted(snapshot.voiceMuted);
    outputAudio.muted = snapshot.voiceMuted;
    for (const track of avatar?.stream.getAudioTracks() || []) track.enabled = !snapshot.voiceMuted;
    browser?.reconcile(snapshot);
    transcription?.reconcileFlush(snapshot.transcriptFlushRevision);
    const mention = demand?.observe(snapshot);
    if (mention) void handMention(mention);
    void demand?.reconcile()?.catch(notice);
    update();
  };
  const accept = (source: MeetMediaSource) => {
    if (suspended) return;
    media?.attach(source);
    // A platform that labels speakers supplies the transcript; recognizing its mixed feed again would only add unattributed duplicates.
    if (!room?.snapshot.platformTranscript) transcription?.attach(source);
  };
  const releaseMedia = async () => {
    browser?.close();
    playout?.close();
    playout = null;
    outputAudio.pause(); outputAudio.srcObject = null;
    avatar?.close();
    input.getTracks().forEach((track) => track.stop());
    video.pause(); video.srcObject = null; stage.remove();
    const currentMedia = media; media = null;
    await currentMedia?.close();
  };
  const suspend = (): Promise<void> => {
    suspended = true;
    demand?.stop();
    voice?.suspend();
    input.getTracks().forEach((track) => track.stop());
    for (const track of avatar?.stream.getAudioTracks() || []) { track.enabled = false; track.stop(); }
    room?.close(false);
    update({ status: "suspended", voice: "Voice suspended", playback: "stopped" });
    voiceStopping ??= voice?.stop() ?? Promise.resolve();
    void voiceStopping!.catch(notice);
    suspending ??= Promise.all([transcription?.suspend(), releaseMedia()]).then(() => {})
      .catch((cause) => { suspending = null; throw cause; });
    return suspending;
  };
  const reopen = async () => {
    const joined = await meetJson<MeetJoined>(options.request, meetPath("external"), post({
      namespace: options.namespace, eventKey: options.eventKey, name: options.name,
    }));
    if (joined.room.id !== room!.snapshot.id || joined.participant.id !== room!.joined.participant.id) {
      throw new Error("External meeting recovery changed its room or mixed-audio identity");
    }
    room!.snapshot = joined.room;
    update();
  };
  const retryTranscription = async () => {
    if (suspended) { await suspend(); await reopen(); }
    await transcription?.retry(!suspended);
  };
  const close = (): Promise<void> => {
    if (state.status === "closed") return Promise.resolve();
    if (closing) return closing;
    const localStopped = suspend();
    update({ status: "closing" });
    closing = (async () => {
      await localStopped;
      await voiceStopping;
      await reopen();
      await transcription?.close();
      await room!.json(meetPath("external", `/${encodeURIComponent(room!.snapshot.id)}/stop`), post({}));
      update({ status: "closed", voice: "Voice off", playback: "stopped" });
    })().catch((cause) => {
      update({ status: "error", notice: String(cause instanceof Error ? cause.message : cause) });
      throw cause;
    }).finally(() => { closing = null; });
    return closing;
  };
  const recovery: MeetAdapterRecovery = { get state() { return state; }, suspend, close, retryTranscription };

  try {
    const joined = await meetJson<MeetJoined>(options.request, meetPath("external"), post({
      namespace: options.namespace, eventKey: options.eventKey, name: options.name,
    }));
    room = new MeetRoom(joined, "", reconcile, accept, (id) => {
      media?.detach(id); transcription?.detach(id);
    }, (message) => {
      roomFailure = message;
      update({ status: "error", notice: message });
      void suspend().catch(notice);
      if (running) void close().catch(notice);
    }, options.request);
    state = { status: "connecting", voice: "Voice off", playback: "stopped", notice: "", inputSource: "mixed", room: joined.room };
    if (!joined.participant.host || joined.participant.name !== "Mixed meeting audio") {
      throw new Error("The external host must identify its audio source as Mixed meeting audio");
    }
    media = new MeetMedia();
    await media.audio.resume();
    playout = await MeetVoicePlayout.create(media.audio, data => options.onAudioDiagnostic?.({ stage: "playout", at: performance.now(), ...data as object }));
    outputAudio.srcObject = playout.stream;
    outputAudio.muted = joined.room.voiceMuted;
    transcription = new MeetTranscription(room, notice);
    await transcription.flushPending();
    browser = new MeetBrowser(room, (stream) => options.onBrowserStream?.(stream), notice);
    room.publish("camera", input);
    accept({ participant: joined.participant, kind: "camera", stream: input });
    avatar = await avatarStream(__MEET_AVATAR__, () => ({
      voice: state.voice, playback: state.playback, muted: room!.snapshot.voiceMuted, threads: room!.snapshot.threads,
    }));
    for (const track of playout.stream.getAudioTracks()) avatar.stream.addTrack(track.clone());
    room.publish("pi-camera", avatar.stream);
    video.srcObject = avatar.stream;
    options.container.append(stage);
    await video.play();
    const current = room;
    voice = new VoiceSession({
      request: options.request,
      sessionId: joined.room.sessionId,
      input: media.voiceInput.stream,
      outputMuted: joined.room.voiceMuted,
      externalPlayback: true,
      meetingContext,
      handoffContext: () => transcription!.handoff(),
      onVoiceControl: (control) => current.applyVoiceControl(control),
      onFragment: (fragment) => {
        if (fragment.role !== "assistant") return;
        demand?.activity();
        if (!current.snapshot.voiceMuted) transcription!.saveVoice(fragment);
      },
      onOutput: (stream) => {
        playout!.attach(stream);
        void outputAudio.play().catch(error => notice(`Meeting voice playback failed: ${String(error)}`));
      },
      onPlayback: (playback) => update({ playback }),
      onAudioDiagnostic: data => options.onAudioDiagnostic?.(data),
      // A Voice failure is shown on the dashboard and retried while Voice is wanted; it no longer ends the meeting's transcript and canvas.
      onState: (status, detail) => {
        if (detail === "Agent queued…") demand?.activity();
        update({ voice: detail || status });
      },
      onNotice: notice,
    });
    const session = voice;
    demand = new VoiceDemand({
      get state() { return session.state; },
      get working() { return pendingWork(session.delegations, Date.now()); },
      start: () => session.start(),
      stop: () => session.stop(),
    });
    reconcile(joined.room);
    void room.poll();
    await demand.reconcile();
    if (roomFailure) throw new Error(roomFailure);
    running = true;
    update({ status: "live" });
    return {
      get state() { return state; },
      get cameraStream() { return avatar!.stream; },
      get browserStream() { return browser!.stream; },
      suspend, close,
      async setMuted(muted) {
        const control = await current.json<MeetVoiceControl>(current.path("/voice"), post({ muted }));
        current.applyVoiceControl(control);
      },
      async shareBrowser(url) {
        const shared = await current.json<NonNullable<MeetSnapshot["browser"]>>(current.path("/browser"), post({ url }));
        current.snapshot = { ...current.snapshot, browser: shared }; reconcile(current.snapshot);
      },
      async stopSharing() {
        await current.json(current.path("/browser"), { method: "DELETE" });
        current.snapshot = { ...current.snapshot, browser: null }; reconcile(current.snapshot);
      },
      retryTranscription,
      resumePlayback: () => voice!.resumePlayback(),
    };
  } catch (cause) {
    if (!room) { await releaseMedia(); throw cause; }
    try { await close(); }
    catch (cleanup) {
      throw new MeetAdapterStartError(new AggregateError([cause, cleanup],
        [...new Set([cause, cleanup].map((error) => String(error instanceof Error ? error.message : error)))].join("; ")), recovery);
    }
    throw cause;
  }
}
