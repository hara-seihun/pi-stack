import { useEffect, useState } from "react";
import { SPEECH_RATES, speech, useSpeech } from "../../speech";

export function SpeechSettings() {
  const state = useSpeech();
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    if (!state.engine) { setLoading(false); return; }
    setLoading(true);
    void speech.loadVoices(attempt > 0).then(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [state.engine, attempt]);
  const engine = state.catalog?.engines.find(engine => engine.id === state.engine);
  const voiceKnown = state.voices.some(voice => voice.id === state.voice);
  const rateKnown = SPEECH_RATES.some(rate => rate === state.rate);
  const authenticated = Boolean(window.PiRemotePerson.session());
  return <div className="settings-speech">
    <p className="settings-detail">Playback preferences on this device belong to your account.</p>
    <label>Playback rate<select aria-label="Speech playback rate" value={state.rate} disabled={!authenticated} onChange={event => speech.setRate(Number(event.target.value))}>
      {!rateKnown && <option value={state.rate} disabled>Unsupported saved rate</option>}{SPEECH_RATES.map(rate => <option key={rate} value={rate}>{rate}×</option>)}
    </select></label>
    {state.engine ? <>
      <p>Speech engine: {engine ? engine.name : state.engine}</p>
      <label>Voice<select aria-label="Speech voice" value={state.voice ?? ""} disabled={!authenticated || loading || Boolean(state.voicesError) || state.voices.length === 0} onChange={event => speech.setVoice(event.target.value)}>
        {state.voice === null && <option value="" disabled>Not set — choose a voice</option>}
        {state.voice !== null && !voiceKnown && <option value={state.voice} disabled>{state.voice} · {loading ? "Checking" : "Unavailable"}</option>}
        {state.voices.map(voice => <option key={voice.id} value={voice.id} title={voice.description}>{voice.name}</option>)}
      </select></label>
      {loading && <p role="status">Loading configured voices…</p>}
      {!loading && !state.voicesError && state.voices.length === 0 && <p>The configured engine reported no voices.</p>}
      <button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Refresh voices</button>
    </> : <p>No speech engine is configured in this environment.</p>}
    {state.voicesError && <p role="alert">{state.voicesError}</p>}
    {state.error && <p role="alert">{state.error}</p>}
  </div>;
}
