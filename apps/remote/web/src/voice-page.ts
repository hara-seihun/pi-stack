import "./person";
import "./native";
import "./voice";

const element = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Voice control ${id} is missing`);
  return value as T;
};
const params = new URLSearchParams(location.search);
const sessionId = params.get("sessionId") || "";
const name = params.get("name") || "Agent";
const title = element<HTMLElement>("title");
const status = element<HTMLElement>("status");
const orb = element<HTMLElement>("orb");
const start = element<HTMLButtonElement>("start");
const controls = element<HTMLElement>("controls");
const mute = element<HTMLButtonElement>("mute");
title.textContent = `${name} · Voice`;

if (!sessionId) {
  status.textContent = "No thread was selected";
  orb.classList.add("error");
  start.disabled = true;
} else {
  const voice = window.PiRemoteVoice.create({
    sessionId,
    onState(state, detail) {
      status.textContent = detail || state;
      orb.classList.toggle("live", state === "live");
      orb.classList.toggle("error", state === "error");
      start.hidden = state === "connecting" || state === "live";
      controls.hidden = state !== "live";
      if (state === "idle") { start.textContent = "Start voice"; mute.textContent = "Mute"; }
      if (state === "error") start.textContent = "Try again";
    },
    onNotice(message) { status.textContent = message; },
  });
  start.addEventListener("click", () => void voice.start());
  mute.addEventListener("click", () => { mute.textContent = voice.toggleMute() ? "Unmute" : "Mute"; });
  element("play").addEventListener("click", () => void voice.resumePlayback());
  element("hush").addEventListener("click", () => voice.hush());
  element("hangup").addEventListener("click", () => voice.stop());
  window.addEventListener("pagehide", () => voice.stop());
}
