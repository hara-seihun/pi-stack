import { useEffect } from "react";
import { SPEECH_RATES, speech, useSpeech } from "./speech";
import "./speech-bar.css";

const PlayIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>;
const StopIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>;

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The reader: what is being read, play/pause, stop, rate and voice. Hidden until a message is spoken. */
export function SpeechBar() {
  const state = useSpeech();
  const open = state.status !== "idle";
  useEffect(() => { if (open) void speech.loadVoices(); }, [open, state.engine]);
  if (!open) return null;
  const nextRate = () => {
    const index = SPEECH_RATES.indexOf(state.rate as typeof SPEECH_RATES[number]);
    speech.setRate(SPEECH_RATES[(index + 1) % SPEECH_RATES.length]);
  };
  const label = state.status === "loading" ? "Preparing…" : state.status === "error" ? state.error : state.status === "paused" ? `Paused · ${clock(state.position)}` : clock(state.position);
  return <div className={`speech-bar ${state.status}`} role="region" aria-label={state.title ? `Reader: ${state.title}` : "Reader"}>
    <button type="button" className="speech-control" aria-label={state.status === "playing" ? "Pause" : "Play"} disabled={state.status === "error"} onClick={() => speech.toggle()}>{state.status === "playing" ? <PauseIcon /> : <PlayIcon />}</button>
    <div className="speech-text">
      <span className="speech-status" title={state.status === "error" ? label : undefined}>{label}</span>
      {state.voices.length > 0 && state.status !== "error" && <select className="speech-voice" aria-label="Voice" value={state.voice ?? ""} onChange={event => speech.setVoice(event.target.value)}>{state.voices.map(voice => <option key={voice.id} value={voice.id} title={voice.description}>{voice.name}</option>)}</select>}
    </div>
    <button type="button" className="speech-rate" aria-label={`Speed ${state.rate}×. Change`} onClick={nextRate}>{state.rate}×</button>
    <button type="button" className="speech-control" aria-label="Stop reading" onClick={() => speech.stop()}><StopIcon /></button>
  </div>;
}
