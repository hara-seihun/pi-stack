import "../person";
import "../native";
import "../voice";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { API } from "../../../server/api";
import { meetPath, type MeetJoined, type MeetSnapshot } from "../../../server/meet/protocol";
import { piFetch, registerUnlockHandler } from "../client";
import { avatarStream, MeetMedia, type MeetMediaSource } from "./media";
import { meetRequest, MeetRoom, post } from "./room";
import "./style.css";

const params = new URLSearchParams(location.search);
const inviteRoom = params.get("room") || "";
const owner = params.get("user") || window.PiRemotePerson.get();
const environmentReady = params.get("environment")
  ? window.KenanRemote!.select({ id: params.get("environment")!, user: owner })
  : window.KenanRemote!.getState();
const sourceKey = (source: MeetMediaSource) => `${source.participant.id}:${source.kind}`;

function MediaTile({ source, muted }: { source: MeetMediaSource; muted: boolean }) {
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
  return <article className={`tile ${screen ? "screen-tile" : ""}`}>
    <video ref={video} autoPlay playsInline muted={muted} />
    {!source.stream.getVideoTracks().length && <div className="audio-avatar">{source.participant.name.slice(0, 1).toUpperCase()}</div>}
    <span className="tile-name">{pi ? "Kenan" : source.participant.name}{screen ? " · Browser" : ""}{muted && !pi ? " · You" : ""}</span>
    {paused && <button className="play-audio" onClick={() => void video.current!.play().then(() => setPaused(false))}>Play audio</button>}
  </article>;
}

function MeetPage() {
  const [sessionId, setSessionId] = useState(params.get("sessionId") || "");
  const [sessions, setSessions] = useState<Array<{ id: string; name: string }>>([]);
  const [name, setName] = useState(localStorage.getItem("pi-meet-name") || "Hara");
  const [camera, setCamera] = useState(true);
  const [microphone, setMicrophone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<MeetSnapshot | null>(null);
  const [sources, setSources] = useState<MeetMediaSource[]>([]);
  const [notice, setNotice] = useState("");
  const [voiceState, setVoiceState] = useState("Voice off");
  const [transcript, setTranscript] = useState<Array<{ role: string; text: string }>>([]);
  const [browserUrl, setBrowserUrl] = useState("https://example.com");
  const [browserBusy, setBrowserBusy] = useState(false);
  const [unlock, setUnlock] = useState<{ message: string; resolve(key: string): void } | null>(null);
  const [key, setKey] = useState("");
  const room = useRef<MeetRoom | null>(null);
  const local = useRef<MediaStream | null>(null);
  const mixer = useRef<MeetMedia | null>(null);
  const voice = useRef<VoiceSession | null>(null);
  const owned = useRef<MediaStream[]>([]);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const generation = useRef(0);
  const cameraVideo = useRef<HTMLVideoElement | null>(null);
  const screenCanvas = useRef<HTMLCanvasElement | null>(null);
  const isHost = Boolean(room.current?.joined.participant.host);

  useEffect(() => {
    registerUnlockHandler((message) => new Promise((resolve) => setUnlock({ message, resolve })));
    void environmentReady.then(async () => {
      if (!inviteRoom) {
        const result = await meetRequest<any>(API.sessions.path(), owner);
        setSessions(result.sessions || []);
      }
    }).catch((cause) => setNotice(String(cause.message || cause)));
    const stop = () => leave();
    window.addEventListener("pagehide", stop);
    return () => { window.removeEventListener("pagehide", stop); leave(); };
  }, []);

  function later(fn: () => void, ms: number) {
    const timer = setTimeout(() => { timers.current.delete(timer); fn(); }, ms);
    timers.current.add(timer);
  }

  function acceptMedia(source: MeetMediaSource) {
    mixer.current?.attach(source);
    setSources((current) => [...current.filter((item) => sourceKey(item) !== sourceKey(source)), source]);
  }

  function leave() {
    generation.current++;
    voice.current?.stop(); voice.current = null;
    room.current?.close(); room.current = null;
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    for (const stream of owned.current) stream.getTracks().forEach((track) => track.stop());
    owned.current = [];
    local.current = null;
    if (cameraVideo.current) { cameraVideo.current.pause(); cameraVideo.current.srcObject = null; cameraVideo.current = null; }
    if (mixer.current) void mixer.current.close().catch((cause) => setNotice(`Audio cleanup: ${String(cause)}`));
    mixer.current = null; screenCanvas.current = null;
    setSnapshot(null); setSources([]); setVoiceState("Voice off"); setBusy(false); setBrowserBusy(false);
  }

  function context() {
    const current = room.current;
    if (!current) return "";
    return JSON.stringify({
      meeting: current.snapshot.id,
      api: current.snapshot.apiUrl,
      supervisorPerson: owner,
      participants: current.snapshot.participants.map((participant) => ({ ...participant, cameraFrame: `${current.snapshot.apiUrl}/participants/${participant.id}/frame` })),
      browser: current.snapshot.browser,
      browserFrame: `${current.snapshot.apiUrl}/browser/frame`,
    });
  }

  async function startVoice() {
    const current = room.current;
    if (!current || !mixer.current) return;
    voice.current?.stop();
    voice.current = window.PiRemoteVoice.create({
      sessionId: current.snapshot.sessionId, input: mixer.current.voiceInput.stream,
      meetingContext: context,
      onState: (_state, detail) => setVoiceState(detail || _state),
      onNotice: setNotice,
      onTranscript: (role, text) => setTranscript((lines) => [...lines.slice(-99), { role, text }]),
      onOutput: (stream) => {
        if (room.current !== current) return;
        const avatar = current.published.get("pi-camera")!;
        for (const track of avatar.getAudioTracks()) { avatar.removeTrack(track); track.stop(); }
        for (const track of stream.getAudioTracks()) avatar.addTrack(track.clone());
        current.publish("pi-camera", avatar);
        acceptMedia({ participant: current.joined.participant, kind: "pi-camera", stream: avatar });
      },
    });
    await voice.current.start();
  }

  async function uploadCamera(current: MeetRoom, video: HTMLVideoElement) {
    if (room.current !== current) return;
    try {
      if (video.readyState >= 2) {
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 360;
        canvas.getContext("2d")!.drawImage(video, 0, 0, 640, 360);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
        if (blob && room.current === current) await meetRequest(current.path("/frame"), owner, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: blob });
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
      if (!owner) throw new Error("Choose your Pi Remote person on the main page first");
      if (!inviteRoom && !sessionId) throw new Error("Choose a Pi Remote thread");
      if (!inviteRoom && owner !== window.PiRemotePerson.get()) throw new Error("Switch to this person in Pi Remote before hosting their meeting");
      await environmentReady;
      if (attempt !== generation.current) return;
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error("Open Meet on the Tailscale HTTPS link to use your microphone and camera");
      if (!inviteRoom) { media = new MeetMedia(); await media.audio.resume(); mixer.current = media; }
      const stream = microphone || camera ? await navigator.mediaDevices.getUserMedia({
        audio: microphone ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
        video: camera ? { width: { ideal: 960 }, height: { ideal: 540 } } : false,
      }) : new MediaStream();
      if (attempt !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      local.current = stream; owned.current.push(stream);
      localStorage.setItem("pi-meet-name", name.trim());
      const joined = await meetRequest<MeetJoined>(inviteRoom ? meetPath(inviteRoom, "/join") : meetPath(), owner, post({ sessionId, name: name.trim() }));
      const current = new MeetRoom(joined, owner, setSnapshot, acceptMedia, (id) => {
        mixer.current?.detach(id); setSources((items) => items.filter((item) => item.participant.id !== id));
      }, (message) => { setNotice(message); leave(); });
      if (attempt !== generation.current) { current.close(); return; }
      room.current = current; setSnapshot(joined.room);
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
        const avatar = await avatarStream("/kenan.png");
        if (room.current !== current) { avatar.getTracks().forEach((track) => track.stop()); return; }
        owned.current.push(avatar); current.publish("pi-camera", avatar);
        acceptMedia({ participant: joined.participant, kind: "pi-camera", stream: avatar });
        void startVoice();
      }
    } catch (cause) { setNotice(String(cause.message || cause)); leave(); }
    finally { setBusy(false); }
  }

  async function drawBrowser(current: MeetRoom, canvas: HTMLCanvasElement) {
    if (room.current !== current) return;
    try {
      const response = await piFetch(meetPath(current.snapshot.id, "/browser/frame"), { headers: { "x-pi-remote-user": owner }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!response.ok) throw new Error(`Browser frame HTTP ${response.status}`);
      const image = await createImageBitmap(await response.blob());
      if (room.current === current) canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
      if (room.current === current) later(() => void drawBrowser(current, canvas), 200);
    } catch (cause) { if (room.current === current) setNotice(`Browser sharing stopped: ${String(cause.message || cause)}`); }
  }

  async function shareBrowser() {
    const current = room.current;
    if (!current) return;
    setBrowserBusy(true); setNotice("");
    try {
      const browser = await meetRequest<NonNullable<MeetSnapshot["browser"]>>(current.path("/browser"), owner, post({ url: browserUrl }));
      if (room.current !== current) return;
      current.snapshot = { ...current.snapshot, browser }; setSnapshot(current.snapshot);
      if (!screenCanvas.current) {
        const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
        screenCanvas.current = canvas;
        const stream = canvas.captureStream(5); owned.current.push(stream);
        current.publish("pi-screen", stream);
        acceptMedia({ participant: current.joined.participant, kind: "pi-screen", stream });
        void drawBrowser(current, canvas);
      }
    } catch (cause) { setNotice(String(cause.message || cause)); }
    finally { setBrowserBusy(false); }
  }

  function toggle(kind: "audio" | "video") {
    const tracks = local.current?.getTracks().filter((track) => track.kind === kind) || [];
    if (!tracks.length) { setNotice(`You joined without ${kind === "audio" ? "a microphone" : "a camera"}. Leave and rejoin to enable it.`); return; }
    const enabled = !tracks[0]!.enabled;
    tracks.forEach((track) => { track.enabled = enabled; });
    if (kind === "audio") setMicrophone(enabled); else setCamera(enabled);
  }

  async function invite() {
    if (!snapshot) return;
    const url = new URL(location.href);
    try {
      const environment = await environmentReady;
      url.search = new URLSearchParams({ room: snapshot.id, user: owner, environment: environment.id }).toString();
      await navigator.clipboard.writeText(url.href); setNotice("Invite link copied. Guests need access to this Tailscale host.");
    } catch { setNotice(url.href); }
  }

  return <main className="meet">
    <header className="meet-header"><a className="brand" href="/"><img src="/kenan.png" alt="Kenan"/><span>PiStack <strong>Meet</strong></span></a><a className="back" href="/">Pi Remote ↗</a></header>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
    {!snapshot ? <section className="lobby"><div><p className="eyebrow">A room for you and your agent</p><h1>{inviteRoom ? "Join the conversation." : "Let's meet."}</h1><p>Talk with Kenan and other people. Keep each person's camera and microphone separate, and watch Kenan work in a shared browser.</p><div className="lobby-avatar"><img src="/kenan.png" alt="Kenan's meeting avatar"/></div></div>
      <form onSubmit={(event) => { event.preventDefault(); void join(); }}><h2>{inviteRoom ? "Join meeting" : "Start a meeting"}</h2>
        <label>Your name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required/></label>
        {!inviteRoom && <label>Pi Remote thread<select value={sessionId} onChange={(event) => setSessionId(event.target.value)} required><option value="">Choose a thread</option>{sessionId && !sessions.some((session) => session.id === sessionId) && <option value={sessionId}>Selected thread</option>}{sessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}</select></label>}
        <label className="check"><input type="checkbox" checked={microphone} onChange={(event) => setMicrophone(event.target.checked)}/>Microphone</label><label className="check"><input type="checkbox" checked={camera} onChange={(event) => setCamera(event.target.checked)}/>Camera</label>
        <p className="privacy">Audio goes to PiStack Voice. The agent can read each camera's latest snapshot. Meet does not record media; Voice requests and agent work stay in the thread. Frames disappear when you leave. Keep the host tab open.</p>
        <button className="primary" disabled={busy}>{busy ? "Connecting…" : inviteRoom ? "Join meeting" : "Start meeting"}</button>
      </form></section> : <>
      <div className="room-heading"><div><h1>Meeting room</h1><p>{snapshot.participants.length} {snapshot.participants.length === 1 ? "person" : "people"} · {isHost ? voiceState : "Connected to host"}</p></div><button onClick={() => void invite()}>Copy invite link</button></div>
      <div className="meeting-layout"><section className="stage" aria-label="Meeting streams">{[...sources].sort((a, b) => Number(b.kind.endsWith("screen")) - Number(a.kind.endsWith("screen"))).map((source) => <MediaTile key={sourceKey(source)} source={source} muted={source.participant.id === room.current?.joined.participant.id}/>)}</section>
        <aside><h2>In this room</h2>{snapshot.participants.map((participant) => <div className="person" key={participant.id}><span>{participant.name}</span><small>{participant.host ? "Host" : "Guest"}</small></div>)}<div className="person"><span>Kenan</span><small>PiStack Voice</small></div>
          {isHost && <><h2>Shared browser</h2><form onSubmit={(event) => { event.preventDefault(); void shareBrowser(); }}><label>Address<input type="url" value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} required/></label><button disabled={browserBusy}>{browserBusy ? "Opening…" : snapshot.browser ? "Navigate" : "Share browser"}</button></form><p className="hint">This browser runs on the PiStack host. Kenan can operate it through the browser tool.</p>{snapshot.browser && <details><summary>Browser connection</summary><code>{snapshot.browser.endpoint}</code></details>}<h2>Voice transcript</h2><div className="transcript" aria-live="polite">{transcript.length ? transcript.map((line, index) => <p key={index}><strong>{line.role === "assistant" ? "Kenan" : "Room"}</strong> {line.text}</p>) : <p className="hint">Speech appears here during the call.</p>}</div></>}
        </aside></div>
      <footer className="controls"><button aria-pressed={!microphone} onClick={() => toggle("audio")}>{microphone ? "Mute mic" : "Unmute mic"}</button><button aria-pressed={!camera} onClick={() => toggle("video")}>{camera ? "Camera off" : "Camera on"}</button>{isHost && <><button onClick={() => voice.current?.hush()}>Hush Kenan</button><button onClick={() => void startVoice()}>Reconnect voice</button></>}<button className="leave" onClick={leave}>{isHost ? "End meeting" : "Leave"}</button></footer>
    </>}
    {unlock && <div className="unlock"><form onSubmit={(event) => { event.preventDefault(); unlock.resolve(key); setKey(""); setUnlock(null); }}><h2>Unlock Pi Remote</h2><p>{unlock.message}</p><label>Folder key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} autoFocus required/></label><button className="primary">Unlock</button></form></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<MeetPage/>);
