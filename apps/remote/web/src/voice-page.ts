import "./person";
import "./native";
import "./voice";
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { SignInDialog } from "./SignInDialog";
import { RequestIndicator } from "./RequestIndicator";

const authentication = document.createElement("div");
document.body.append(authentication);
createRoot(authentication).render(createElement(Fragment, null, createElement(RequestIndicator), createElement(SignInDialog)));

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
const start = element<HTMLButtonElement>("start");
const controls = element<HTMLElement>("controls");
const mute = element<HTMLButtonElement>("mute");
title.textContent = `${name} · Voice`;

if (!sessionId) {
  status.textContent = "No thread was selected";
  start.disabled = true;
} else {
  const voice = window.PiRemoteVoice.create({
    sessionId,
    onState(state, detail) {
      status.textContent = detail || state;
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
  window.addEventListener("pi-person", () => {
    void voice.stop();
    start.disabled = true;
    status.textContent = "Person changed. Open voice again from your thread.";
  });
}
