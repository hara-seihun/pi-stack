"use strict";

(() => {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("sessionId") || "";
  const name = params.get("name") || "Agent";
  const title = document.getElementById("title");
  const status = document.getElementById("status");
  const orb = document.getElementById("orb");
  const start = document.getElementById("start");
  const controls = document.getElementById("controls");
  const mute = document.getElementById("mute");
  title.textContent = `${name} · Voice`;

  if (!sessionId) {
    status.textContent = "No thread was selected";
    orb.classList.add("error");
    start.disabled = true;
    return;
  }

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

  start.addEventListener("click", () => voice.start());
  mute.addEventListener("click", () => { mute.textContent = voice.toggleMute() ? "Unmute" : "Mute"; });
  document.getElementById("hush").addEventListener("click", () => voice.hush());
  document.getElementById("hangup").addEventListener("click", () => voice.stop());
  window.addEventListener("pagehide", () => voice.stop());
})();
