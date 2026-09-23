import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MessagingCall, MessagingConversation, MessagingSnapshot } from "../../server/messaging/protocol";
import { messagingAvatarUrl } from "./messaging-avatar";
import { MessagingCallAudio } from "./messaging-call-audio";
import { messagingClient } from "./messaging-client";
import "./messaging-call.css";

function PhoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3l3 5-2 2c1.4 2.8 3.2 4.6 6 6l2-2 5 3-1 4c-9.4.5-17.5-7.6-17-17l4-1z" /></svg>;
}
function MicrophoneIcon({ muted }: { muted: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5zm-3 6a6 6 0 0 0 12 0M12 17v4m-3 0h6" />{muted && <path d="M4 4l16 16" />}</svg>;
}

const labels: Record<MessagingCall["state"], string> = {
  ringing_incoming: "Incoming Signal call",
  ringing_outgoing: "Calling…",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  ended: "Call ended",
};

export function formatCallDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function useCallDuration(call: MessagingCall): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (call.connectedAt === null || call.state === "ended") return;
    const timer = setInterval(() => tick(value => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [call.connectedAt, call.state]);
  if (call.connectedAt === null) return "";
  const until = call.endedAt ?? Date.now();
  return formatCallDuration(until - call.connectedAt);
}

class RingTone {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  async start() {
    const context = new AudioContext();
    this.context = context;
    await context.resume();
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);
    const oscillators = [440, 480].map(frequency => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      return oscillator;
    });
    const ring = () => {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.055, now + 0.02);
      gain.gain.setValueAtTime(0.055, now + 0.7);
      gain.gain.linearRampToValueAtTime(0, now + 0.75);
      gain.gain.setValueAtTime(0, now + 1.5);
      gain.gain.linearRampToValueAtTime(0.055, now + 1.52);
      gain.gain.setValueAtTime(0.055, now + 2.2);
      gain.gain.linearRampToValueAtTime(0, now + 2.25);
    };
    ring();
    this.timer = setInterval(ring, 4_000);
    context.addEventListener("statechange", () => { if (context.state === "closed") oscillators.forEach(oscillator => oscillator.disconnect()); });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.context?.close();
    this.context = null;
  }
}

interface CallActions {
  busy: boolean;
  active: boolean;
  error: string;
  place(backendId: string, conversationId: string): void;
  accept(): void;
  hangup(): void;
  mute(muted: boolean): void;
}
const CallContext = createContext<CallActions | null>(null);

function callTitle(call: MessagingCall, conversations: MessagingConversation[]): string {
  return call.peerName || conversations.find(item => item.id === call.conversationId)?.title || call.peer;
}

export function MessagingCallSurface({ call, conversations, busy, error, audioStatus, onAccept, onHangup, onMute }: {
  call: MessagingCall;
  conversations: MessagingConversation[];
  busy: boolean;
  error: string;
  audioStatus?: string;
  onAccept(): void;
  onHangup(): void;
  onMute(muted: boolean): void;
}) {
  const title = callTitle(call, conversations);
  const avatar = messagingAvatarUrl(call.backendId, call.peer, call.avatar);
  const duration = useCallDuration(call);
  const incoming = call.state === "ringing_incoming";
  const detail = call.error || error || (call.state === "ended" ? call.reason : null) || audioStatus;
  return <section className={`signal-call ${incoming ? "incoming" : "active"}`} role="dialog" aria-modal="false" aria-label={`${labels[call.state]} from ${title}`}>
    <div className="signal-call-card">
      <div className="signal-call-avatar">{avatar ? <img src={avatar} alt="" /> : <span aria-hidden="true">{title.trim().charAt(0).toUpperCase() || "?"}</span>}</div>
      <div className="signal-call-copy">
        <strong>{title}</strong>
        <span role="status">{labels[call.state]}{duration ? ` · ${duration}` : ""}</span>
        {detail && <small role={call.error || error ? "alert" : undefined}>{detail.replaceAll("_", " ")}</small>}
      </div>
      {incoming ? <div className="signal-call-actions incoming-actions">
        <button type="button" className="call-decline" disabled={busy} onClick={onHangup}><PhoneIcon /><span>Decline</span></button>
        <button type="button" className="call-accept" disabled={busy} onClick={onAccept}><PhoneIcon /><span>Accept</span></button>
      </div> : call.state !== "ended" && <div className="signal-call-actions">
        <button type="button" className={call.muted ? "call-muted" : ""} disabled={busy} aria-pressed={call.muted} onClick={() => onMute(!call.muted)}><MicrophoneIcon muted={call.muted} /><span>{call.muted ? "Unmute" : "Mute"}</span></button>
        <button type="button" className="call-hangup" disabled={busy} onClick={onHangup}><PhoneIcon /><span>Hang up</span></button>
      </div>}
    </div>
  </section>;
}

export function MessagingCallProvider({ snapshot, children }: { snapshot: MessagingSnapshot; children: ReactNode }) {
  const call = snapshot.calls.find(item => item.state !== "ended") ?? snapshot.calls.at(0) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [audioStatus, setAudioStatus] = useState("");
  const operation = useRef<AbortController | null>(null);
  const audio = useRef<MessagingCallAudio | null>(null);
  const ringer = useRef<RingTone | null>(null);

  useEffect(() => () => {
    operation.current?.abort();
    ringer.current?.stop();
    void audio.current?.stop();
  }, []);

  useEffect(() => {
    ringer.current?.stop();
    ringer.current = null;
    if (call?.state !== "ringing_incoming") return;
    const next = new RingTone();
    ringer.current = next;
    void next.start().catch(() => {});
    return () => { next.stop(); if (ringer.current === next) ringer.current = null; };
  }, [call?.id, call?.state]);

  const beginAudio = useCallback((id: string, muted: boolean) => {
    if (audio.current) { if (id) audio.current.attachCall(id); audio.current.setMuted(muted); return audio.current; }
    const session = new MessagingCallAudio(id, setAudioStatus);
    audio.current = session;
    session.setMuted(muted);
    setAudioStatus("");
    void session.start().catch(cause => {
      if (audio.current !== session) return;
      setAudioStatus(cause instanceof Error ? cause.message : String(cause));
      void session.stop();
    });
    return session;
  }, []);
  const audioActive = !!call && ["ringing_outgoing", "connecting", "connected", "reconnecting"].includes(call.state);
  useEffect(() => {
    if (!call || !audioActive) {
      const previous = audio.current;
      audio.current = null;
      if (previous) void previous.stop();
      return;
    }
    const session = beginAudio(call.id, call.muted);
    return () => { if (audio.current === session) audio.current = null; void session.stop(); };
  }, [call?.id, audioActive, beginAudio]);
  useEffect(() => { if (call) audio.current?.setMuted(call.muted); }, [call?.muted]);

  const run = useCallback(async (request: (signal: AbortSignal) => ReturnType<typeof messagingClient.acceptCall>): Promise<MessagingCall | null> => {
    if (operation.current) return null;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError("");
    const result = await request(controller.signal);
    if (controller.signal.aborted) return null;
    operation.current = null; setBusy(false);
    if (!result.ok) { setError(result.error.message); return null; }
    return result.value.call;
  }, []);

  const actions = useMemo<CallActions>(() => ({
    busy,
    active: !!call && call.state !== "ended",
    error,
    place: (backendId, conversationId) => {
      const session = beginAudio("", false);
      void run(signal => messagingClient.placeCall(backendId, conversationId, crypto.randomUUID(), signal)).then(placed => {
        if (placed) { session.attachCall(placed.id); return; }
        if (audio.current !== session) return;
        audio.current = null;
        void session.stop();
      });
    },
    accept: () => { if (call) {
      const session = beginAudio(call.id, call.muted);
      void run(signal => messagingClient.acceptCall(call.id, signal)).then(accepted => {
        if (accepted || audio.current !== session) return;
        audio.current = null;
        void session.stop();
      });
    } },
    hangup: () => { if (call) void run(signal => messagingClient.hangupCall(call.id, signal)); },
    mute: muted => { if (call) void run(signal => messagingClient.muteCall(call.id, muted, signal)); },
  }), [busy, error, call?.id, call?.state, call?.muted, beginAudio, run]);

  return <CallContext.Provider value={actions}>
    {children}
    {call && <MessagingCallSurface call={call} conversations={snapshot.conversations} busy={busy} error={error} audioStatus={audioStatus} onAccept={actions.accept} onHangup={actions.hangup} onMute={actions.mute} />}
  </CallContext.Provider>;
}

export function SignalCallButton({ conversation, available, enabled }: { conversation: MessagingConversation; available: boolean; enabled: boolean }) {
  const calls = useContext(CallContext);
  if (!calls || conversation.kind !== "direct" || !available) return null;
  return <button type="button" className="header-icon signal-call-button" aria-label={`Call ${conversation.title} on Signal`} title={enabled ? undefined : "Signal calling is unavailable"} disabled={!enabled || calls.busy || calls.active} onClick={() => calls.place(conversation.backendId, conversation.id)}><PhoneIcon /></button>;
}
