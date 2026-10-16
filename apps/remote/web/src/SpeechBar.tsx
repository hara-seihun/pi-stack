import { useEffect } from "react";
import { SPEECH_RATES, speech, useSpeech, type SpeechState } from "./speech";
import { assertNever } from "../../shared/explicit-state";
import "./speech-bar.css";

const PlayIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>;
const StopIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>;

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function speechLabel(state: SpeechState): string {
  switch (state.status) {
    case "idle": return "";
    case "loading": return "Preparing…";
    case "error": return state.error;
    case "paused": return `Paused · ${clock(state.position)}`;
    case "playing": return clock(state.position);
  }
  return assertNever(state.status, "Speech status");
}

/** The reader: what is being read, play/pause, stop, rate and voice. Hidden until a message is spoken. */
export function SpeechBar() {
  const state = useSpeech();
  useEffect(() => {
    const refresh = () => speech.refreshIdentity();
    refresh();
    window.addEventListener("pi-person", refresh);
    window.addEventListener("pi-auth", refresh);
    return () => { window.removeEventListener("pi-person", refresh); window.removeEventListener("pi-auth", refresh); speech.stop(); };
  }, []);
  const open = state.status !== "idle";
  useEffect(() => { if (open) void speech.loadVoices(); }, [open, state.engine]);
  return <SpeechBarControls state={state} onToggle={() => speech.toggle()} onVoice={voice => speech.setVoice(voice)} onRate={() => {
    const index = SPEECH_RATES.indexOf(state.rate as typeof SPEECH_RATES[number]);
    speech.setRate(SPEECH_RATES[(index + 1) % SPEECH_RATES.length]);
  }} onStop={() => speech.stop()} />;
}

export function SpeechBarControls({ state, onToggle, onVoice, onRate, onStop }: {
  state: SpeechState;
  onToggle(): void;
  onVoice(voice: string): void;
  onRate(): void;
  onStop(): void;
}) {
  if (state.status === "idle") return null;
  const label = speechLabel(state);
  return <div className={`speech-bar ${state.status}`} role="region" aria-label={state.title ? `Reader: ${state.title}` : "Reader"}>
    <button type="button" className="speech-control" aria-label={state.status === "playing" ? "Pause" : "Play"} disabled={state.status === "error"} onClick={onToggle}>{state.status === "playing" ? <PauseIcon /> : <PlayIcon />}</button>
    <div className="speech-text">
      <span className="speech-status" title={state.status === "error" ? label : undefined}>{label}</span>
      {state.voices.length > 0 && state.status !== "error" && <select className="speech-voice" aria-label="Voice" value={state.voice ?? ""} disabled={Boolean(state.voicesError)} onChange={event => onVoice(event.target.value)}>{state.voice === null && <option value="" disabled>Not set</option>}{state.voice !== null && !state.voices.some(voice => voice.id === state.voice) && <option value={state.voice} disabled>{state.voice} · Unavailable</option>}{state.voices.map(voice => <option key={voice.id} value={voice.id} title={voice.description}>{voice.name}</option>)}</select>}
    </div>
    <button type="button" className="speech-rate" aria-label={`Speed ${state.rate}×. Change`} onClick={onRate}>{state.rate}×</button>
    <button type="button" className="speech-control" aria-label="Stop reading" onClick={onStop}><StopIcon /></button>
  </div>;
}
