import { useSyncExternalStore } from "react";
import { API } from "../../server/api";
import type { SpeechCatalog, SpeechUtterance, SpeechVoice } from "../../server/protocol";
import { appStorageKey } from "./app-path";
import { api, piFetch } from "./client";
import { resourceUrl } from "./resource-url";
import { readSpeechPreference, writeSpeechPreference, type SpeechPreferenceResult, type SpeechPreferenceStore } from "./speech-preferences";

export const SPEECH_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

export interface SpeechState {
  catalog: SpeechCatalog | null;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  error: string;
  title: string;
  rate: number;
  engine: string | null;
  voice: string | null;
  voices: SpeechVoice[];
  voicesError: string;
  /** Seconds played of the current utterance. */
  position: number;
}

const preferences: SpeechPreferenceStore = { storage: () => localStorage, key: appStorageKey };
const currentIdentity = () => ({ user: window.PiRemotePerson?.get() ?? "", session: window.PiRemotePerson?.session() ?? "" });

/** One player for the whole client: the message being read, its rate and voice. */
class SpeechPlayer {
  private state: SpeechState = { catalog: null, status: "idle", error: "", title: "", rate: 1, engine: null, voice: null, voices: [], voicesError: "", position: 0 };
  private readonly listeners = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private utterance: SpeechUtterance | null = null;
  private request = 0;
  private identity = { user: "", session: "" };

  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(next: Partial<SpeechState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  refreshIdentity() {
    const next = currentIdentity();
    if (next.user === this.identity.user && next.session === this.identity.session) return;
    const catalog = next.user === this.identity.user ? this.state.catalog : null;
    this.identity = next;
    this.stop();
    this.audio = null;
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    this.patch({ catalog: null, engine: null, voice: null, voices: [], voicesError: "", rate: 1 });
    if (next.user && next.session) this.configure(catalog);
  }

  configure(catalog: SpeechCatalog | null) {
    this.refreshIdentity();
    if (!this.identity.user || !this.identity.session) return;
    const engines = catalog?.engines ?? [];
    const engine = engines.find(item => item.id === this.state.engine) ?? engines[0] ?? null;
    const ratePreference = readSpeechPreference(preferences, this.identity.user, "rate");
    const voicePreference = engine ? readSpeechPreference(preferences, this.identity.user, `voice:${engine.id}`) : { ok: true as const, value: null };
    let rate = this.state.rate;
    let error = this.state.status === "error" ? this.state.error : "";
    if (!ratePreference.ok) error = ratePreference.error;
    else if (ratePreference.value !== null) {
      const storedRate = Number(ratePreference.value);
      if (SPEECH_RATES.some(candidate => candidate === storedRate)) rate = storedRate;
      else error = "The saved speech rate is invalid. Choose an available rate.";
    }
    let voice: string | null = null;
    if (!voicePreference.ok) error = voicePreference.error;
    else voice = voicePreference.value !== null ? voicePreference.value : engine?.defaultVoice ?? null;
    const changedEngine = engine?.id !== this.state.engine;
    this.patch({ catalog: engines.length ? catalog : null, engine: engine?.id ?? null, voice, rate, error, voices: changedEngine ? [] : this.state.voices, voicesError: changedEngine ? "" : this.state.voicesError });
    if (!engines.length && this.state.status !== "idle") this.stop();
  }

  get available() { return this.state.catalog !== null; }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = "auto";
    (audio as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
    const listen = (event: string, action: () => void) => audio.addEventListener(event, () => { if (this.audio === audio) action(); });
    listen("playing", () => this.patch({ status: "playing", error: "" }));
    listen("pause", () => { if (!audio.ended && this.state.status === "playing") this.patch({ status: "paused" }); });
    listen("ended", () => this.patch({ status: "idle", position: 0 }));
    listen("timeupdate", () => this.patch({ position: audio.currentTime }));
    listen("error", () => void this.failed(audio.error?.message || "Playback failed"));
    listen("stalled", () => { if (this.state.status === "playing") this.patch({ status: "loading" }); });
    listen("waiting", () => { if (this.state.status === "playing") this.patch({ status: "loading" }); });
    this.audio = audio;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => this.resume());
      navigator.mediaSession.setActionHandler("pause", () => this.pause());
      navigator.mediaSession.setActionHandler("stop", () => this.stop());
    }
    return audio;
  }

  private async failed(fallback: string) {
    if (this.state.status === "idle") return;
    const request = this.request;
    let message = fallback;
    if (this.utterance) {
      try {
        const status = await api(API.speechUtterance.method, API.speechUtterance.path({ utteranceId: this.utterance.id })) as SpeechUtterance;
        if (status.error) message = status.error;
      } catch {}
    }
    if (request === this.request) this.patch({ status: "error", error: message });
  }

  /** Read `text` aloud; `title` names it in the player. Replaces whatever was playing. */
  async speak(text: string, title: string) {
    this.refreshIdentity();
    if (!this.state.engine) { this.patch({ status: "error", error: "This host reads nothing aloud: no speech engine is configured." }); return; }
    const request = ++this.request;
    const audio = this.element();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    this.utterance = null;
    this.patch({ status: "loading", error: "", title, position: 0 });
    let utterance: SpeechUtterance;
    try {
      utterance = await api(API.speechUtterances.method, API.speechUtterances.path(), { text, engine: this.state.engine, voice: this.state.voice }) as SpeechUtterance;
    } catch (cause) {
      if (request === this.request) this.patch({ status: "error", error: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    if (request !== this.request) return;
    this.utterance = utterance;
    audio.defaultPlaybackRate = this.state.rate;
    audio.playbackRate = this.state.rate;
    audio.src = resourceUrl(API.speechAudio.path({ utteranceId: utterance.id }));
    if ("mediaSession" in navigator && "MediaMetadata" in window) navigator.mediaSession.metadata = new MediaMetadata({ title, artist: `${utterance.voice} · PiStack` });
    try { await audio.play(); }
    catch (cause) { if (request === this.request) this.patch({ status: "error", error: cause instanceof Error ? cause.message : String(cause) }); }
  }

  pause() { this.audio?.pause(); }
  resume() { const request = this.request; void this.audio?.play().catch(cause => { if (request === this.request) this.patch({ status: "error", error: cause instanceof Error ? cause.message : String(cause) }); }); }
  toggle() { this.state.status === "playing" ? this.pause() : this.resume(); }
  stop() {
    this.request++;
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); }
    this.utterance = null;
    this.patch({ status: "idle", error: "", title: "", position: 0 });
  }

  setRate(rate: number): SpeechPreferenceResult<void> {
    this.refreshIdentity();
    const result = !this.identity.session ? { ok: false as const, error: "Sign in to save speech preferences." } : !SPEECH_RATES.some(candidate => candidate === rate) ? { ok: false as const, error: "Choose an available speech rate." } : writeSpeechPreference(preferences, this.identity.user, "rate", String(rate));
    if (!result.ok) { this.patch({ error: result.error }); return result; }
    if (this.audio) { this.audio.defaultPlaybackRate = rate; this.audio.playbackRate = rate; }
    this.patch({ rate, error: this.state.status === "error" ? this.state.error : "" });
    return result;
  }

  setVoice(voice: string): SpeechPreferenceResult<void> {
    this.refreshIdentity();
    const engine = this.state.engine;
    const result = !this.identity.session ? { ok: false as const, error: "Sign in to save speech preferences." } : !engine || !this.state.voices.some(candidate => candidate.id === voice) ? { ok: false as const, error: "Choose a voice reported by the configured speech engine." } : writeSpeechPreference(preferences, this.identity.user, `voice:${engine}`, voice);
    if (!result.ok) { this.patch({ error: result.error }); return result; }
    this.patch({ voice, error: this.state.status === "error" ? this.state.error : "" });
    return result;
  }

  async loadVoices(refresh?: boolean) {
    this.refreshIdentity();
    const engine = this.state.engine;
    const identity = this.identity;
    const active = () => engine === this.state.engine && identity.user === this.identity.user && identity.session === this.identity.session;
    if (!engine || (!refresh && this.state.voices.length)) return;
    try {
      const response = await piFetch(API.speechVoices.path({ engineId: engine }), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (!active()) return;
      if (!Array.isArray(body.voices) || body.voices.some((voice: unknown) => !voice || typeof voice !== "object" || !("id" in voice) || typeof voice.id !== "string" || !voice.id || !("name" in voice) || typeof voice.name !== "string" || ("description" in voice && typeof voice.description !== "string"))) {
        this.patch({ voicesError: "The speech engine returned an invalid voice catalog." });
        return;
      }
      const voices = body.voices as SpeechVoice[];
      if (new Set(voices.map(voice => voice.id)).size !== voices.length) { this.patch({ voicesError: "The speech engine returned duplicate voice identifiers." }); return; }
      this.patch({ voices, voicesError: "" });
    } catch (cause) {
      if (active()) this.patch({ voicesError: `Voices unavailable: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }
}

export const speech = new SpeechPlayer();
window.addEventListener("pi-person", () => speech.refreshIdentity());
window.addEventListener("pi-auth", () => speech.refreshIdentity());

export function useSpeech(): SpeechState {
  return useSyncExternalStore(speech.subscribe, speech.snapshot, speech.snapshot);
}

export function speechTitle(text: string): string {
  const line = text.replace(/[#*_`>\[\]]/g, "").split("\n").map(part => part.trim()).find(Boolean) ?? "Message";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
