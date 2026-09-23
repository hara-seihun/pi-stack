import "../person";
import { bootstrapUrl, nativePlatform, remote } from "../native";
import { appPath, appStorageKey } from "../app-path";
import "../voice";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MeetingStart } from "./start";
import { MeetTranscription } from "./transcription";
import { meetPath, type MeetJoined, type MeetSnapshot, type MeetTranscriptTurn, type MeetVoiceControl } from "../../../server/meet/protocol";
import { ensureUnlocked, registerUnlockHandler } from "../client";
import { SignInDialog } from "../SignInDialog";
import { RequestIndicator } from "../RequestIndicator";
import { avatarStream, MeetMedia, type MeetMediaSource } from "./media";
import { MeetBrowser } from "./browser";
import { meetRequest, MeetRoom, post } from "./room";
import "./style.css";

const params = new URLSearchParams(location.search);
const inviteRoom = params.get("room") || "";
let owner = params.get("user") || window.PiRemotePerson.get();
let environmentPromise: Promise<any> | null = null;
async function environmentReady() {
  await ensureUnlocked();
  owner = params.get("user") || window.PiRemotePerson.get();
  return environmentPromise ??= params.get("environment")
    ? window.KenanRemote!.select({ id: params.get("environment")!, user: owner })
    : window.KenanRemote!.getState();
}
const sourceKey = (source: MeetMediaSource) => `${source.participant.id}:${source.kind}`;

function MediaTile({ source, muted, showIdentity }: { source: MeetMediaSource; muted: boolean; showIdentity: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const element = video.current!;
    element.srcObject = source.stream;
    void element.play().then(() => setPaused(false), () => setPaused(true));
    return () => { element.srcObject = null; };
  }, [source.stream]);
  const pi = source.kind.startsWith("pi-");
  const screen = source.kind.endsWith("screen");
  const participantLabel = `${source.participant.name} · ${source.participant.host ? "Host" : "Guest"}${muted ? " · You" : ""}`;
  const accessibleLabel = pi ? (screen ? "Shared browser" : "Kenan meeting dashboard") : participantLabel;
  return <article aria-label={accessibleLabel} className={`tile ${screen ? "screen-tile" : source.kind === "pi-camera" ? "pi-camera-tile" : ""}`}>
    <video ref={video} autoPlay playsInline muted={muted} />
    {!pi && showIdentity && <span className="tile-name">{participantLabel}</span>}
    {paused && <button className="play-audio" onClick={() => void video.current!.play().then(() => setPaused(false))}>Play audio</button>}
  </article>;
}

function MeetPage() {
  const meetingStart = useRef<MeetingStart | null>(null);
  const [name, setName] = useState(localStorage.getItem(appStorageKey("pi-meet-name")) || "Hara");
  const [camera, setCamera] = useState(true);
  const [microphone, setMicrophone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<MeetSnapshot | null>(null);
  const [sources, setSources] = useState<MeetMediaSource[]>([]);
  const [notice, setNotice] = useState("");
  const [playbackState, setPlaybackState] = useState("stopped");
  const [transcript, setTranscript] = useState<MeetTranscriptTurn[]>([]);
  const [meetings, setMeetings] = useState<Array<{ id: string; createdAt: number }>>([]);
  const transcription = useRef<MeetTranscription | null>(null);
  const [browserUrl, setBrowserUrl] = useState("https://example.com");
  const [browserBusy, setBrowserBusy] = useState(false);
  const [unlock, setUnlock] = useState<{ message: string; resolve(key: string): void } | null>(null);
  const [key, setKey] = useState("");
  const room = useRef<MeetRoom | null>(null);
  const local = useRef<MediaStream | null>(null);
  const mixer = useRef<MeetMedia | null>(null);
  const voice = useRef<VoiceSession | null>(null);
  const cameraStatus = useRef({ voice: "Voice off", playback: "stopped" });
  const owned = useRef<MediaStream[]>([]);
  const closeAvatar = useRef<(() => void) | null>(null);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const generation = useRef(0);
  const ending = useRef(false);
  const finishing = useRef(false);
  const cameraVideo = useRef<HTMLVideoElement | null>(null);
  const browserAddress = useRef<HTMLInputElement | null>(null);
  const browserPublisher = useRef<MeetBrowser | null>(null);
  const isHost = Boolean(room.current?.joined.participant.host);

  useEffect(() => {
    registerUnlockHandler((message) => {
      if (!window.PiRemotePerson.get()) throw new Error("Choose your Pi Remote person on the main page first");
      return new Promise((resolve) => setUnlock({ message, resolve }));
    });
    let ready = false;
    void environmentReady().then(() => { ready = true; }, (cause) => setNotice(String(cause.message || cause)));
    const stop = () => leave();
    const personChanged = () => { if (ready) { leave(); setMeetings([]); setNotice("Person changed. Return to Pi Remote before starting another meeting."); } };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pi-person", personChanged);
    return () => { window.removeEventListener("pagehide", stop); window.removeEventListener("pi-person", personChanged); leave(); };
  }, []);

  useEffect(() => {
    if (inviteRoom) return;
    void environmentReady().then(() => meetRequest<{ meetings: Array<{ id: string; createdAt: number }> }>(meetPath(), owner))
      .then((result) => setMeetings(result.meetings)).catch((cause) => setNotice(String(cause.message || cause)));
  }, [snapshot?.id]);

  function transcriptLink(id: string) {
    return window.KenanRemote!.resolveApiUrl(`${meetPath(id, "/transcript")}?format=text&user=${encodeURIComponent(owner)}`);
  }

  function later(fn: () => void, ms: number) {
    const timer = setTimeout(() => { timers.current.delete(timer); fn(); }, ms);
    timers.current.add(timer);
  }

  function acceptMedia(source: MeetMediaSource) {
    if (ending.current) return;
    mixer.current?.attach(source);
    transcription.current?.attach(source);
    setSources((current) => [...current.filter((item) => sourceKey(item) !== sourceKey(source)), source]);
  }

  function leave() {
    generation.current++;
    voice.current?.stop(); voice.current = null;
    if (transcription.current) void transcription.current.close().catch((cause) => setNotice(`Transcript finalization: ${String(cause.message || cause)}`));
    transcription.current = null;
    browserPublisher.current?.close(); browserPublisher.current = null;
    room.current?.close(); room.current = null;
    if (nativePlatform) void remote.keepAwake?.({ enabled: false }).catch((cause) => setNotice(`Screen wake lock: ${String(cause.message || cause)}`));
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    for (const stream of owned.current) stream.getTracks().forEach((track) => track.stop());
    owned.current = [];
    closeAvatar.current?.(); closeAvatar.current = null;
    local.current = null;
    if (cameraVideo.current) { cameraVideo.current.pause(); cameraVideo.current.srcObject = null; cameraVideo.current = null; }
    if (mixer.current) void mixer.current.close().catch((cause) => setNotice(`Audio cleanup: ${String(cause)}`));
    mixer.current = null;
    cameraStatus.current = { voice: "Voice off", playback: "stopped" };
    ending.current = false;
    setSnapshot(null); setSources([]); setPlaybackState("stopped"); setBusy(false); setBrowserBusy(false);
  }

  async function finishMeeting() {
    if (finishing.current) return;
    finishing.current = true;
    ending.current = true;
    setBusy(true);
    try {
      voice.current?.suspend();
      for (const stream of owned.current) stream.getTracks().forEach((track) => track.stop());
      browserPublisher.current?.close(); browserPublisher.current = null;
      closeAvatar.current?.(); closeAvatar.current = null;
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
      setSources([]);
      await Promise.all([transcription.current?.suspend(), voice.current?.stop()]);
      await transcription.current?.close();
      transcription.current = null;
      leave();
    } catch (cause) {
      setNotice(`Media stopped, but the final transcript still needs saving. Retry ending the meeting: ${String(cause.message || cause)}`);
    } finally {
      finishing.current = false;
      setBusy(false);
    }
  }

  function context() {
    const current = room.current;
    if (!current) return "";
    return [
      `People in the meeting: ${current.snapshot.participants.map((participant) => participant.name).join(", ")}.`,
      `Kenan's outgoing voice is ${current.snapshot.voiceMuted ? "muted" : "unmuted"}.`,
      current.snapshot.browser ? `Shared browser: ${current.snapshot.browser.url}` : "No browser is being shared.",
    ].join("\n");
  }

  async function startVoice() {
    const current = room.current;
    if (!current || !mixer.current || ending.current) return;
    await voice.current?.stop();
    voice.current = window.PiRemoteVoice.create({
      sessionId: current.snapshot.sessionId, input: mixer.current.voiceInput.stream,
      meetingContext: context, outputMuted: current.snapshot.voiceMuted,
      onVoiceControl: (state) => { if (room.current === current) current.applyVoiceControl(state); },
      handoffContext: () => transcription.current!.handoff(),
      onFragment: (fragment) => {
        if (fragment.role === "assistant" && !current.snapshot.voiceMuted) transcription.current?.saveVoice(fragment);
      },
      onPlayback: (state) => {
        if (room.current !== current) return;
        cameraStatus.current.playback = state;
        setPlaybackState(state);
        for (const track of current.published.get("pi-camera")?.getAudioTracks() || []) track.enabled = !current.snapshot.voiceMuted && state !== "stopped";
      },
      onState: (_state, detail) => {
        if (room.current !== current) return;
        cameraStatus.current.voice = detail || _state;
      },
      onNotice: setNotice,
      onOutput: (stream) => {
        if (room.current !== current) return;
        const avatar = current.published.get("pi-camera")!;
        for (const track of avatar.getAudioTracks()) { avatar.removeTrack(track); track.stop(); }
        for (const track of stream.getAudioTracks()) {
          const outgoing = track.clone(); outgoing.enabled = !current.snapshot.voiceMuted; avatar.addTrack(outgoing);
        }
        current.publish("pi-camera", avatar);
        acceptMedia({ participant: current.joined.participant, kind: "pi-camera", stream: avatar });
      },
    });
    try { await voice.current.start(); }
    catch (cause) { if (room.current === current) setNotice(`Voice: ${String(cause.message || cause)}`); }
  }

  function reconcileVoice(current: MeetRoom) {
    if (!current.joined.participant.host || ending.current) return;
    voice.current?.setOutputMuted(current.snapshot.voiceMuted);
    for (const track of current.published.get("pi-camera")?.getAudioTracks() || []) track.enabled = !current.snapshot.voiceMuted;
  }

  async function setKenanMuted(muted: boolean) {
    const current = room.current;
    if (!current?.joined.participant.host) return;
    try {
      const result = await meetRequest<MeetVoiceControl>(current.path("/voice"), owner, post({ muted }));
      if (room.current === current) current.applyVoiceControl(result);
    } catch (cause) { setNotice(`Kenan mute control: ${String(cause.message || cause)}`); }
  }

  async function uploadCamera(current: MeetRoom, video: HTMLVideoElement) {
    if (room.current !== current || ending.current) return;
    try {
      const cameraEnabled = () => (video.srcObject as MediaStream | null)?.getVideoTracks().some((track) => track.enabled && track.readyState === "live");
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight && cameraEnabled()) {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
        if (blob && room.current === current && cameraEnabled()) await meetRequest(current.path("/frame"), owner, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: blob });
      }
      if (room.current === current) later(() => void uploadCamera(current, video), 2_000);
    } catch (cause) { setNotice(`Camera snapshots stopped: ${String(cause.message || cause)}`); }
  }

  async function join() {
    setBusy(true); setNotice(""); setTranscript([]);
    const attempt = ++generation.current;
    let media: MeetMedia | null = null;
    try {
      if (!name.trim()) throw new Error("Enter your name");
      await environmentReady();
      if (!inviteRoom && owner !== window.PiRemotePerson.get()) throw new Error("Switch to this person in Pi Remote before hosting their meeting");
      if (attempt !== generation.current) return;
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error("Meet needs a secure WebView or the Tailscale HTTPS link for microphone and camera access");
      if (!inviteRoom) {
        const configuration = await meetRequest<{ transcriptionAvailable: boolean }>(meetPath(), owner);
        if (!configuration.transcriptionAvailable) throw new Error("This host needs deploy/transcription before it can save speaker-labelled meetings");
        media = new MeetMedia(); await media.audio.resume(); mixer.current = media; }
      const stream = microphone || camera ? await navigator.mediaDevices.getUserMedia({
        audio: microphone ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
        video: camera ? { width: { ideal: 960 }, height: { ideal: 540 } } : false,
      }) : new MediaStream();
      if (attempt !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      local.current = stream; owned.current.push(stream);
      localStorage.setItem(appStorageKey("pi-meet-name"), name.trim());
      const joined = inviteRoom
        ? await meetRequest<MeetJoined>(meetPath(inviteRoom, "/join"), owner, post({ name: name.trim() }))
        : await (meetingStart.current ??= new MeetingStart(owner)).start(name.trim());
      const current = new MeetRoom(joined, owner, (next) => {
        setSnapshot(next);
        if (next.browser?.url && document.activeElement !== browserAddress.current) setBrowserUrl(next.browser.url);
        reconcileVoice(current);
        if (!ending.current) {
          browserPublisher.current?.reconcile(next);
          transcription.current?.reconcileFlush(next.transcriptFlushRevision);
        }
        void meetRequest<{ turns: MeetTranscriptTurn[] }>(meetPath(next.id, "/transcript"), owner).then((result) => {
          if (room.current === current) setTranscript(result.turns);
        }).catch((cause) => setNotice(`Transcript: ${String(cause.message || cause)}`));
      }, acceptMedia, (id) => {
        mixer.current?.detach(id); transcription.current?.detach(id); setSources((items) => items.filter((item) => item.participant.id !== id));
      }, (message) => { setNotice(message); if (!ending.current) leave(); });
      if (attempt !== generation.current) { current.close(); return; }
      room.current = current; setSnapshot(joined.room);
      if (nativePlatform) void remote.keepAwake?.({ enabled: true }).catch((cause) => {
        if (room.current === current) setNotice(`Could not keep the screen awake: ${String(cause.message || cause)}`);
      });
      if (joined.participant.host) {
        transcription.current = new MeetTranscription(current, setNotice);
        browserPublisher.current = new MeetBrowser(current, (stream) => {
          if (stream) acceptMedia({ participant: joined.participant, kind: "pi-screen", stream });
          else setSources((items) => items.filter((item) => item.kind !== "pi-screen"));
        }, setNotice);
      }
      current.publish("camera", stream);
      acceptMedia({ participant: joined.participant, kind: "camera", stream });
      void current.poll();
      if (stream.getVideoTracks().length) {
        const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream;
        cameraVideo.current = video;
        await video.play();
        void uploadCamera(current, video);
      }
      if (joined.participant.host) {
        const avatar = await avatarStream(appPath("kenan.png"), () => ({
          ...cameraStatus.current, muted: current.snapshot.voiceMuted, threads: current.snapshot.threads,
        }));
        if (room.current !== current || ending.current) { avatar.close(); return; }
        closeAvatar.current = avatar.close;
        current.publish("pi-camera", avatar.stream);
        acceptMedia({ participant: joined.participant, kind: "pi-camera", stream: avatar.stream });
        void startVoice();
      }
    } catch (cause) { setNotice(String(cause.message || cause)); leave(); }
    finally { setBusy(false); }
  }

  async function shareBrowser() {
    const current = room.current;
    if (!current || ending.current) return;
    setBrowserBusy(true); setNotice("");
    try {
      const browser = await meetRequest<NonNullable<MeetSnapshot["browser"]>>(current.path("/browser"), owner, post({ url: browserUrl }));
      if (room.current !== current) return;
      current.snapshot = { ...current.snapshot, browser }; setSnapshot(current.snapshot);
      browserPublisher.current?.reconcile(current.snapshot);
    } catch (cause) { setNotice(String(cause.message || cause)); }
    finally { setBrowserBusy(false); }
  }

  async function stopSharing() {
    const current = room.current;
    if (!current) return;
    setBrowserBusy(true);
    try {
      await meetRequest(current.path("/browser"), owner, { method: "DELETE" });
      if (room.current !== current) return;
      current.snapshot = { ...current.snapshot, browser: null };
      setSnapshot(current.snapshot);
      browserPublisher.current?.reconcile(current.snapshot);
    } catch (cause) { setNotice(`Stop sharing: ${String(cause.message || cause)}`); }
    finally { setBrowserBusy(false); }
  }

  function toggle(kind: "audio" | "video") {
    const tracks = local.current?.getTracks().filter((track) => track.kind === kind) || [];
    if (!tracks.length) { setNotice(`You joined without ${kind === "audio" ? "a microphone" : "a camera"}. Leave and rejoin to enable it.`); return; }
    const enabled = !tracks[0]!.enabled;
    tracks.forEach((track) => { track.enabled = enabled; });
    if (kind === "audio") setMicrophone(enabled);
    else {
      setCamera(enabled);
      const current = room.current;
      if (!enabled && current) void meetRequest(current.path("/frame"), owner, { method: "DELETE" })
        .catch((cause) => setNotice(`Could not clear the camera snapshot: ${String(cause.message || cause)}`));
    }
  }

  async function invite() {
    if (!snapshot) return;
    const url = new URL(location.href);
    try {
      const environment = await environmentReady();
      if (nativePlatform) {
        const frontend = new URL(`${await bootstrapUrl()}/`);
        if (frontend.protocol !== "https:") { setNotice("This environment needs an HTTPS frontend to share meeting invitations outside the app."); return; }
        url.href = new URL("meet.html", frontend).href;
      }
      url.search = new URLSearchParams({ room: snapshot.id, user: owner, environment: environment.id }).toString();
      await navigator.clipboard.writeText(url.href); setNotice("Invite link copied. Guests need access to this Pi Remote host.");
    } catch { setNotice(url.href); }
  }

  return <main className="meet">
    <header className="meet-header"><a className="brand" href={appPath("")}>Pi Remote</a><span className="page-title">Meet</span></header>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
    {snapshot?.browser?.error && <div className="notice" role="status">{snapshot.browser.error}</div>}
    {snapshot?.browser?.watchError && <div className="notice" role="status">{snapshot.browser.watchError}</div>}
    {!snapshot ? <section className="lobby"><div><h1>{inviteRoom ? "Meeting invitation" : "Meet with Kenan"}</h1><p>Talk with Kenan and other people. Each camera and microphone stays separate, and Kenan can work in a shared browser.</p><div className="lobby-avatar"><img src={appPath("kenan.png")} alt="Kenan's meeting avatar"/></div></div>
      <form aria-label={inviteRoom ? "Join meeting" : "Start meeting"} onSubmit={(event) => { event.preventDefault(); void join(); }}>
        <label>Your name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required/></label>
        {!inviteRoom && <p className="hint">The conversation and agent work use a new Pi Remote thread.</p>}
        <label className="check"><input type="checkbox" checked={microphone} onChange={(event) => setMicrophone(event.target.checked)}/>Microphone</label><label className="check"><input type="checkbox" checked={camera} onChange={(event) => setCamera(event.target.checked)}/>Camera</label>
        <p className="privacy">PiStack Voice receives meeting audio. Each microphone is also transcribed separately on the PiStack host. The meeting thread saves the speaker-labelled transcript, including Kenan's speech, and any participant-labelled camera snapshots attached to delegated requests. Audio is deleted after transcription unless a failed job needs it for recovery. The host keeps only each participant's latest frame; undelegated frames disappear when that participant leaves. Keep the host tab open.</p>
        <button className="primary" disabled={busy}>{busy ? "Connecting…" : inviteRoom ? "Join meeting" : "Start meeting"}</button>
        {meetings.length > 0 && <section className="saved-meetings"><h2>Saved transcripts</h2>{meetings.map((meeting) => <p key={meeting.id}><a href={transcriptLink(meeting.id)}>Download {new Date(meeting.createdAt).toLocaleString()}</a></p>)}</section>}
      </form></section> : <>
      <div className="room-heading"><div><h1>Meeting room</h1>{!isHost && <p>Connected to host</p>}</div><button onClick={() => void invite()}>Copy invite link</button></div>
      <div className="meeting-layout"><section className="stage" aria-label="Meeting streams">{[...sources].sort((a, b) => Number(b.kind.endsWith("screen")) - Number(a.kind.endsWith("screen"))).map((source) => <MediaTile key={sourceKey(source)} source={source} muted={source.participant.id === room.current?.joined.participant.id} showIdentity={sources.find(candidate => candidate.participant.id === source.participant.id && !candidate.kind.startsWith("pi-")) === source}/>)}{snapshot.participants.filter(participant => !sources.some(source => source.participant.id === participant.id && !source.kind.startsWith("pi-"))).map(participant => <article className="tile" key={participant.id}><span className="tile-name">{participant.name} · {participant.host ? "Host" : "Guest"}</span></article>)}</section>
        <aside>{isHost && <><h2>Shared browser</h2><form onSubmit={(event) => { event.preventDefault(); void shareBrowser(); }}><label>Address<input ref={browserAddress} type="url" value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} required/></label><button disabled={browserBusy}>{browserBusy ? "Opening…" : snapshot.browser ? "Navigate" : "Share browser"}</button></form><p className="hint">This browser runs on the PiStack host. Kenan can operate it through the browser tool.</p>{snapshot.browser && <>{snapshot.browser.watchPath && <p className="hint">Watching {snapshot.browser.watchPath}</p>}<button disabled={browserBusy} onClick={() => void stopSharing()}>Stop sharing</button><details><summary>Browser connection</summary><code>{snapshot.browser.endpoint}</code></details></>}</>}<h2>Saved transcript</h2><a href={transcriptLink(snapshot.id)}>Download transcript</a><div className="transcript" aria-live="polite">{transcript.length ? transcript.map((line) => <p key={line.id}><strong title={line.speakerId}>{line.speaker}</strong> {line.text || (line.status === "failed" ? line.error : "Transcribing…")}{line.text && !line.final ? " …" : ""}</p>) : <p className="hint">Each speaker's words appear here and stay saved after the meeting.</p>}</div>{isHost && <button onClick={() => void transcription.current?.retry().then(() => setNotice("Transcription retry accepted"), (cause) => setNotice(String(cause.message || cause)))}>Retry transcription</button>}
        </aside></div>
      <footer className="controls"><button aria-pressed={!microphone} onClick={() => toggle("audio")}>{microphone ? "Mute mic" : "Unmute mic"}</button><button aria-pressed={!camera} onClick={() => toggle("video")}>{camera ? "Camera off" : "Camera on"}</button>{isHost && <><button onClick={() => void setKenanMuted(!snapshot.voiceMuted)}>{snapshot.voiceMuted ? "Unmute Kenan" : "Mute Kenan"}</button>{playbackState === "blocked" && <button onClick={() => void voice.current?.resumePlayback()}>Play Kenan audio</button>}<button disabled={ending.current} onClick={() => void startVoice()}>Reconnect voice</button></>}<button className="leave" disabled={busy} onClick={() => void finishMeeting()}>{busy ? "Saving…" : isHost ? "End meeting" : "Leave"}</button></footer>
    </>}
    {unlock && <div className="unlock"><form onSubmit={(event) => { event.preventDefault(); unlock.resolve(key); setKey(""); setUnlock(null); }}><h2>Pi Remote</h2><p>{unlock.message}</p><label>Folder key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} autoFocus required/></label><button className="primary">Unlock</button></form></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<><RequestIndicator /><SignInDialog /><MeetPage /></>);
