import { API } from "./api.js";
import { createRemoteStore, initialRemoteState } from "./state-machine.js";
import "./voice.js";

const $ = (id) => document.getElementById(id);
const ui = {
  drawer: $("drawer"), drawerScrim: $("drawer-scrim"), threadList: $("thread-list"), archivedList: $("archived-list"),
  drawerTabs: $("drawer-tabs"), threadStartHeading: $("thread-start-heading"),
  threadsTab: $("tab-threads"), agentsTab: $("tab-agents"), archivedTab: $("tab-archived"),
  threadsTabCount: $("tab-threads-count"), agentsTabCount: $("tab-agents-count"), archivedTabCount: $("tab-archived-count"),
  agentList: $("agent-list"), agentBanner: $("agent-banner"), composer: $("composer"),
  connection: $("connection"), planSummary: $("plan-summary"),
  usageSummary: $("usage-summary"), newThreadButtons: $("new-thread-buttons"),
  thunderControl: $("thunder-control"), openaiGovernorControl: $("openai-governor-control"), anthropicGovernorControl: $("anthropic-governor-control"),
  topTitle: $("top-title"), topState: $("top-state"), settingsButton: $("open-settings"),
  empty: $("empty-state"), conversation: $("conversation"), scrollback: $("scrollback"), transcript: $("transcript"),
  liveThinking: $("live-thinking"), liveAnswer: $("live-answer"), prompt: $("prompt"), action: $("action"), voice: $("voice"),
  slashCommands: $("slash-commands"), queueStatus: $("queue-status"), messageQueue: $("message-queue"),
  attachments: $("attachments"), attach: $("attach"), pasteText: $("paste-text"), filePicker: $("file-picker"),
  unlockDialog: $("unlock-dialog"), unlockForm: $("unlock-form"), unlockKey: $("unlock-key"),
  pasteTextDialog: $("paste-text-dialog"), pasteTextForm: $("paste-text-form"), pasteTextName: $("paste-text-name"),
  pasteTextContent: $("paste-text-content"), uploadPastedText: $("upload-pasted-text"),
  settings: $("settings"), settingsScrim: $("settings-scrim"), settingsThread: $("settings-thread"),
  settingsActivity: $("settings-activity"), settingsCwd: $("settings-cwd"), model: $("model-select"), thinking: $("thinking-select"),
  speed: $("speed-select"),
};

const effects = {
  "drawer-selected": (tab) => {
    renderTabs();
    renderThreads();
    renderAgentList();
    if (tab === "agents") refreshAgents();
  },
};
const store = createRemoteStore(initialRemoteState(), effects);
const state = new Proxy({}, {
  get: (_target, key) => store.state[key],
  set: (_target, key) => { throw new Error(`State ${String(key)} must change through the reducer`); },
});
const patchState = (value, requestedEffects = []) => store.dispatch({ type: "patch", value, effects: requestedEffects });
const incrementState = (key, by = 1) => store.dispatch({ type: "increment", key, by });
const mapState = (key, entry, value) => store.dispatch({ type: "map-set", key, entry, value });
const deleteMapState = (key, entry) => store.dispatch({ type: "map-delete", key, entry });
const clearMapState = (key) => store.dispatch({ type: "map-clear", key });
const addSetState = (key, value) => store.dispatch({ type: "set-add", key, value });
const deleteSetState = (key, value) => store.dispatch({ type: "set-delete", key, value });
let voiceSession = null;
let voiceThreadId = null;
let threadStartMenu = null;

// The thread poll carries only the newest archived page; older pages load on request.
const ARCHIVED_PAGE_SIZE = 20;

const DRAFT_PREFIX = "pi-remote-draft:";
function loadDraft(id) {
  try { return localStorage.getItem(`${DRAFT_PREFIX}${id}`) || ""; }
  catch (error) { console.error("Could not load thread draft", error); return ""; }
}
function saveDraft(id, value) {
  if (!id) return;
  try {
    if (value) localStorage.setItem(`${DRAFT_PREFIX}${id}`, value);
    else localStorage.removeItem(`${DRAFT_PREFIX}${id}`);
  } catch (error) { console.error("Could not save thread draft", error); }
}
function removeDraft(id) { saveDraft(id, ""); }

const markdown = window.markdownit({ html: false, breaks: true, linkify: true })
  .use(window.texmath, {
    engine: window.katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: { throwOnError: false, strict: "ignore", trust: false },
  });
const defaultLinkOpen = markdown.renderer.rules.link_open
  || ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, env, renderer);
};

function presentationMarkdown(source) {
  let value = String(source || "");
  if (!state.selectedId) return value;
  value = value.replace(/<pi-remote-file\s+src=["']([^"']+)["']\s*\/\s*>/gi, (_match, path) => {
    const name = String(path).split("/").filter(Boolean).at(-1) || "Download file";
    const label = name.replaceAll("&", "&amp;").replaceAll("[", "&#91;").replaceAll("]", "&#93;").replace(/[\r\n]+/g, " ");
    return `\n\n[${label}](${API.sessionFiles.path({ sessionId: state.selectedId }, { path })})\n\n`;
  });
  return value;
}
function renderMarkdown(destination, source) {
  const value = source || "";
  if (destination.dataset.markdownSource === value) return;
  destination.dataset.markdownSource = value;
  try { destination.innerHTML = markdown.render(window.normalizeLatexDelimiters(presentationMarkdown(value))); }
  catch { destination.textContent = value; }
}

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

const motionStates = new WeakMap();
const movingElements = new Set();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let motionFrame = 0;
let motionTime = 0;

function motionState(element) {
  let state = motionStates.get(element);
  if (!state) {
    state = {
      x: { value: 0, target: 0, velocity: 0 },
      y: { value: 0, target: 0, velocity: 0 },
      scale: { value: 1, target: 1, velocity: 0 },
      opacity: { value: 1, target: 1, velocity: 0 },
    };
    motionStates.set(element, state);
  }
  return state;
}

function paintMotion(element, state) {
  const y = element.dataset.motionCentered === "true" ? `calc(-50% + ${state.y.value}px)` : `${state.y.value}px`;
  element.style.transform = `translate3d(${state.x.value}px, ${y}, 0) scale(${state.scale.value})`;
  element.style.opacity = String(state.opacity.value);
}

function setMotion(element, values) {
  const state = motionState(element);
  for (const [property, value] of Object.entries(values)) {
    const channel = state[property];
    channel.value = value;
    channel.target = value;
    channel.velocity = 0;
  }
  paintMotion(element, state);
}

function springMotion(element, values, stiffness = 380, damping = 0.62) {
  if (reducedMotion.matches) { setMotion(element, values); return; }
  const state = motionState(element);
  for (const [property, target] of Object.entries(values)) {
    const channel = state[property];
    channel.target = target;
    channel.stiffness = stiffness;
    channel.damping = damping;
  }
  movingElements.add(element);
  if (!motionFrame) {
    motionTime = performance.now();
    motionFrame = requestAnimationFrame(stepMotion);
  }
}

function stepMotion(now) {
  const elapsed = Math.min(0.034, Math.max(0.001, (now - motionTime) / 1000));
  motionTime = now;
  const steps = Math.max(1, Math.ceil(elapsed * 120));
  const dt = elapsed / steps;
  for (const element of [...movingElements]) {
    const state = motionState(element);
    let moving = false;
    for (const channel of Object.values(state)) {
      if (channel.stiffness === undefined) continue;
      const drag = 2 * channel.damping * Math.sqrt(channel.stiffness);
      for (let step = 0; step < steps; step++) {
        const acceleration = channel.stiffness * (channel.target - channel.value) - drag * channel.velocity;
        channel.velocity += acceleration * dt;
        channel.value += channel.velocity * dt;
      }
      const distance = Math.abs(channel.target - channel.value);
      const speed = Math.abs(channel.velocity);
      if (distance < 0.001 && speed < 0.01) {
        channel.value = channel.target;
        channel.velocity = 0;
        channel.stiffness = undefined;
      } else moving = true;
    }
    paintMotion(element, state);
    if (!moving) movingElements.delete(element);
  }
  motionFrame = movingElements.size ? requestAnimationFrame(stepMotion) : 0;
}

// A supervisor only runs while its owner's key is in memory, so 423 is the
// ordinary state of a machine that has just rebooted rather than an error. Every
// call goes through here, so unlocking is handled once: the stored key is tried
// silently, the person is asked only if there isn't one or it no longer works,
// and the original request is then retried as if nothing had happened.
const KEY_STORAGE = "pi-remote-key";
let unlocking = null;

function storedKey() {
  try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; }
}
function rememberKey(key) {
  try { localStorage.setItem(KEY_STORAGE, key); } catch {}
}
async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function sendUnlock(key) {
  const response = await fetch(API.unlock.path(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ key }),
    cache: "no-store",
  });
  const result = await responseJson(response);
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function askForKey(message) {
  return new Promise((resolve) => {
    const error = $("unlock-error");
    error.hidden = !message;
    error.textContent = message ?? "";
    ui.unlockKey.value = "";
    if (!ui.unlockDialog.open) ui.unlockDialog.showModal();
    ui.unlockKey.focus();
    ui.unlockForm.onsubmit = (event) => {
      event.preventDefault();
      const key = ui.unlockKey.value;
      if (key) resolve(key);
    };
  });
}

async function ensureUnlocked() {
  if (unlocking) return unlocking;
  unlocking = (async () => {
    let key = storedKey();
    let message = null;
    for (;;) {
      if (key) {
        try {
          await sendUnlock(key);
          rememberKey(key);
          if (ui.unlockDialog.open) ui.unlockDialog.close();
          return;
        } catch (error) { message = error?.message || "Could not unlock"; }
      }
      key = await askForKey(message);
    }
  })().finally(() => { unlocking = null; });
  return unlocking;
}

// Uploads and the voice channel talk to the server directly rather than through
// api(), and they must survive a locked supervisor the same way. This is the
// same retry in the shape those call sites already use.
async function piFetch(input, init) {
  const response = await fetch(input, init);
  if (response.status !== 423) return response;
  await ensureUnlocked();
  return fetch(input, init);
}
window.piFetch = piFetch;

async function api(method, path, body, timeout = 20000, retryOnLock = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const result = await responseJson(response);
    if (response.status === 423 && retryOnLock) {
      clearTimeout(timer);
      await ensureUnlocked();
      return api(method, path, body, timeout, false);
    }
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Request timed out");
    throw error;
  } finally { clearTimeout(timer); }
}

async function syncRequest(body, signal, retryOnLock = true) {
  if (signal.aborted) throw new DOMException("Synchronization cancelled", "AbortError");
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 35_000);
  try {
    const response = await fetch(API.sync.path(), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const result = await responseJson(response);
    if (response.status === 423 && retryOnLock) {
      await ensureUnlocked();
      return syncRequest(body, signal, false);
    }
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  } catch (error) {
    if (error?.name === "AbortError" && timedOut) throw new Error("Synchronization timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

function activityLabel(activity, tool = "") {
  if (activity === "WAITING_ON_TOOL") return tool ? `WAITING ON ${tool.toUpperCase()}` : "WAITING ON TOOL";
  return ["THINKING", "COMPACTING", "RETRYING", "QUEUED", "WORKING", "STARTING", "ABORTING", "FAILED"].includes(activity) ? activity : "IDLE";
}
function stateActivity(value) {
  if (["FAILED", "STARTING", "ABORTING"].includes(value)) return value;
  return value === "RUNNING" ? "WORKING" : "IDLE";
}
function working(value) { return ["RUNNING", "STARTING", "ABORTING"].includes(value); }
function activityColor(activity) {
  if (["FAILED", "ABORTING"].includes(activity)) return "var(--danger)";
  return activity === "IDLE" ? "var(--muted)" : "var(--accent)";
}

function selectedPendingAction() {
  return state.selectedId ? state.pendingActions.get(state.selectedId) || null : null;
}
function agentTitle(run) {
  return run ? `${run.label} · ${run.taskId}` : "Agent";
}
function agentActivityLabel(run) {
  if (!run) return "IDLE";
  if (run.status === "running") return activityLabel(run.activity || "WORKING");
  return run.status.toUpperCase();
}
function agentDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function updateChrome() {
  if (state.agentRunId) {
    const run = state.agentRun;
    ui.topTitle.textContent = agentTitle(run);
    const label = agentActivityLabel(run);
    ui.topState.textContent = label;
    ui.topState.style.color = run?.status === "running" ? activityColor(run.activity || "WORKING") : "var(--muted)";
    ui.settingsButton.disabled = true;
    updateComposer();
    return;
  }
  ui.topTitle.textContent = state.selectedId ? state.selectedName : "Pi Remote";
  const pending = selectedPendingAction();
  const displayActivity = pending?.type === "abort" ? "ABORTING"
    : pending?.type === "send" && !working(state.selectedState) ? "QUEUED"
    : state.selectedActivity;
  const label = activityLabel(displayActivity, state.selectedTool);
  ui.topState.textContent = label;
  ui.topState.style.color = activityColor(displayActivity);
  ui.settingsButton.disabled = !state.selectedId;
  if (state.settingsOpen) {
    ui.settingsThread.textContent = `Thread ${state.selectedName}`;
    ui.settingsActivity.textContent = label;
    ui.settingsCwd.textContent = state.selectedCwd;
    ui.settingsActivity.style.color = activityColor(displayActivity);
  }
  updateComposer();
}

function updateQueueStatus() {
  const parts = [];
  if (state.steeringQueued) parts.push(`${state.steeringQueued} steering after current tool calls`);
  if (state.followUpQueued) parts.push(`${state.followUpQueued} queued for after completion`);
  ui.queueStatus.textContent = parts.join(" · ");
  ui.queueStatus.hidden = parts.length === 0;
}

function queuedPreview(text = "") {
  return text.split("\n").find((line) => line.trim())?.trim() || "Attached files";
}
function renderMessageQueue() {
  ui.messageQueue.replaceChildren();
  for (const message of state.queuedMessages) {
    const row = node("div", "queued-message");
    const copy = node("div", "queued-message-copy");
    copy.append(node("span", "queued-message-label", message.status || "Queued"), node("span", "queued-message-preview", queuedPreview(message.text)));
    row.append(copy);
    const actions = node("div", "queued-message-actions");
    if (message.canSteer) {
      const steer = node("button", "queued-message-action steer-instead", "STEER");
      steer.type = "button"; steer.title = "Deliver after the current tool calls";
      steer.addEventListener("click", () => steerQueuedMessage(message, actions));
      actions.append(steer);
    }
    if (message.canCancel) {
      const edit = node("button", "queued-message-action edit-queued", "EDIT");
      edit.type = "button"; edit.title = "Cancel and return this message to the composer";
      edit.addEventListener("click", () => cancelQueuedMessage(message, true, actions));
      const cancel = node("button", "queued-message-action cancel-queued", "CANCEL");
      cancel.type = "button"; cancel.title = "Cancel this queued message";
      cancel.addEventListener("click", () => cancelQueuedMessage(message, false, actions));
      actions.append(edit, cancel);
    }
    if (actions.childElementCount) row.append(actions);
    ui.messageQueue.append(row);
  }
  ui.messageQueue.hidden = state.queuedMessages.length === 0;
}

function slashDraftToken() {
  const value = ui.prompt.value;
  if (!value.startsWith("/") || value.includes("\n")) return null;
  const token = value.slice(1).split(/\s/, 1)[0] ?? "";
  return token;
}
function recognizedCommandDraft() {
  const token = slashDraftToken();
  if (token === null) return null;
  return state.slashCommands.find((command) => command.name.toLowerCase() === token.toLowerCase()) || null;
}
// The menu offers the skills and nothing else. A thread's command list also carries MCP
// plumbing and provider commands that nobody picks from a list, and nothing named for MCP
// belongs in it either. Everything hidden here is still a real command and still runs typed.
function commandListed(command) {
  return command.source === "skill" && !command.name.toLowerCase().includes("mcp");
}
function renderSlashCommands() {
  ui.slashCommands.replaceChildren();
  const token = slashDraftToken();
  const completionActive = token !== null && !/\s/.test(ui.prompt.value);
  const visible = !completionActive ? [] : state.slashCommands.filter((command) =>
    commandListed(command) && command.name.toLowerCase().startsWith(token.toLowerCase()));
  for (const command of visible) {
    const button = node("button", "slash-command");
    button.type = "button"; button.role = "option";
    button.append(node("strong", "slash-command-name", `/${command.name}`));
    if (command.description) button.append(node("span", "slash-command-description", command.description));
    button.addEventListener("click", () => {
      ui.prompt.value = `/${command.name} `;
      ui.prompt.focus(); ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
      renderSlashCommands(); updateComposer();
    });
    ui.slashCommands.append(button);
  }
  ui.slashCommands.hidden = !completionActive || visible.length === 0;
}
async function refreshSlashCommands() {
  const id = state.selectedId;
  patchState({ slashCommands: [] });
  renderSlashCommands();
  if (!id) return;
  patchState({ slashCommandsLoading: true });
  try {
    const result = await api(API.sessionCommands.method, API.sessionCommands.path({ sessionId: id }));
    if (state.selectedId === id) { patchState({ slashCommands: Array.isArray(result.commands) ? result.commands : [] }); renderSlashCommands(); updateComposer(); }
  } catch (error) {
    if (state.selectedId === id) console.error(error);
  } finally { patchState({ slashCommandsLoading: false }); }
}
function updateComposer() {
  // Observing an autonomous agent is read-only: the orchestrator owns its work,
  // so the composer, attachments, and queue controls are absent entirely.
  if (state.agentRunId) {
    ui.composer.hidden = true;
    ui.attachments.hidden = true;
    ui.queueStatus.hidden = true;
    ui.messageQueue.hidden = true;
    const run = state.agentRun;
    ui.agentBanner.hidden = false;
    ui.agentBanner.textContent = run
      ? `Observing ${run.label} on ${run.taskId} · ${run.status === "running" ? `running ${agentDuration(run.elapsedMs)}` : `${run.status} after ${agentDuration(run.elapsedMs)}`}${run.provider ? ` · ${run.provider}` : ""} · read-only`
      : "Observing an orchestrator agent · read-only";
    return;
  }
  ui.composer.hidden = false;
  ui.agentBanner.hidden = true;
  const pending = selectedPendingAction();
  const isWorking = working(state.selectedState) || pending?.type === "send";
  const aborting = state.selectedState === "ABORTING" || pending?.type === "abort";
  const acting = Boolean(pending);
  const hasDraft = ui.prompt.value.trim().length > 0;
  const uploading = state.attachments.some((file) => file.uploading);
  const hasAttachment = state.attachments.some((file) => file.path);
  const canSubmit = hasDraft || hasAttachment;
  const command = recognizedCommandDraft();
  const send = pending?.type === "send" || pending?.type === "command" || !isWorking || canSubmit;
  ui.action.classList.toggle("abort", !send);
  ui.action.disabled = acting || uploading || (send ? !canSubmit : aborting);
  ui.action.ariaLabel = aborting ? "Aborting agent" : command ? `Run /${command.name}` : send ? (isWorking ? "Queue message" : "Send message") : "Abort agent";
  ui.action.title = aborting ? "Aborting…" : command ? `Run /${command.name}` : send ? (isWorking ? "Queue for later" : "Send") : "Abort";
  renderSlashCommands();
  ui.attach.disabled = !state.selectedId || uploading;
  ui.pasteText.disabled = !state.selectedId || uploading;
  ui.voice.disabled = !state.selectedId;
  ui.prompt.placeholder = `Message ${state.selectedName}`;
  ui.prompt.style.height = "auto";
  ui.prompt.style.height = `${Math.min(180, Math.max(48, ui.prompt.scrollHeight))}px`;
  updateQueueStatus();
}

function renderMachineToggle(button, active, activeDescription, inactiveDescription, key) {
  const pending = state.machineControlPending.has(key);
  const description = active ? activeDescription : inactiveDescription;
  button.classList.toggle("active", active);
  button.classList.toggle("pending", pending);
  button.disabled = pending;
  button.ariaLabel = description;
  button.title = description;
}
function renderThunderStatus(thunder, authoritative = false) {
  if (!authoritative && state.machineControlPending.has("thunder")) return;
  renderMachineToggle(ui.thunderControl, Boolean(thunder?.active),
    "Thunder sounds are on. Select to turn them off",
    "Thunder sounds are off. Select to turn them on", "thunder");
}
// The drawer button cycles the orchestrator's boost states: normal pace,
// 3× (green), 10× (blue), then halted (red — no new fleet launches for the
// family until the cycle comes back around). The orchestrator owns the
// numbers; the labels repeat what it reports.
const GOVERNOR_STATES = ["off", "green", "blue", "red"];
function governorDescription(name, governor) {
  const current = {
    off: "normal local allowance",
    green: "3× local allowance",
    blue: `${governor.boostedMultiplier ?? 10}× local allowance`,
    red: "a launch halt: no new fleet sessions",
  };
  const next = {
    off: "3× allowance",
    green: `${governor.boostedMultiplier ?? 10}× allowance`,
    blue: "a launch halt",
    red: "normal allowance",
  };
  const at = current[governor.state] ?? "normal local allowance";
  const then = next[governor.state] ?? "3× allowance";
  return `${name} governor is using ${at}. Select for ${then}`;
}
function renderGovernorControls(governors, authoritative = false) {
  for (const provider of ["openai", "anthropic"]) {
    if (!governors?.[provider] || (!authoritative && state.machineControlPending.has(provider))) continue;
    const button = provider === "openai" ? ui.openaiGovernorControl : ui.anthropicGovernorControl;
    const name = provider === "openai" ? "OpenAI" : "Anthropic";
    const governor = { ...state.governors[provider], ...governors[provider] };
    if (!GOVERNOR_STATES.includes(governor.state)) governor.state = governor.boosted ? "blue" : "off";
    patchState({ governors: { ...state.governors, [provider]: governor } });
    const pending = state.machineControlPending.has(provider);
    const description = governorDescription(name, governor);
    button.classList.remove("active", "boost-green", "boost-blue", "halted");
    if (governor.state === "green") button.classList.add("active", "boost-green");
    else if (governor.state === "blue") button.classList.add("active", "boost-blue");
    else if (governor.state === "red") button.classList.add("active", "halted");
    button.classList.toggle("pending", pending);
    button.disabled = pending;
    button.ariaLabel = description;
    button.title = description;
  }
}
function machineControlUnavailable(button, label, key) {
  if (state.machineControlPending.has(key)) return;
  button.classList.remove("active", "pending", "boost-green", "boost-blue", "halted");
  button.disabled = true;
  button.ariaLabel = `${label} unavailable`;
  button.title = `${label} unavailable`;
}
async function refreshMachineControls() {
  const [thunder, governors] = await Promise.allSettled([
    api(API.thunder.method, API.thunder.path()),
    api(API.governors.method, API.governors.path()),
  ]);
  if (thunder.status === "fulfilled") renderThunderStatus(thunder.value.thunder);
  else machineControlUnavailable(ui.thunderControl, "Thunder control", "thunder");
  if (governors.status === "fulfilled") renderGovernorControls(governors.value.governors);
  else {
    machineControlUnavailable(ui.openaiGovernorControl, "OpenAI governor control", "openai");
    machineControlUnavailable(ui.anthropicGovernorControl, "Anthropic governor control", "anthropic");
  }
}
async function toggleThunder() {
  if (state.machineControlPending.has("thunder")) return;
  addSetState("machineControlPending", "thunder");
  renderThunderStatus({ active: ui.thunderControl.classList.contains("active") }, true);
  try {
    const result = await api(API.thunderToggle.method, API.thunderToggle.path(), {});
    deleteSetState("machineControlPending", "thunder");
    renderThunderStatus(result.thunder, true);
  } catch (error) {
    deleteSetState("machineControlPending", "thunder");
    console.error(error);
    refreshMachineControls();
  }
}
async function toggleGovernor(provider) {
  if (state.machineControlPending.has(provider)) return;
  addSetState("machineControlPending", provider);
  // Optimistically advance one step of the cycle; the authoritative render
  // from the response corrects any drift.
  const current = state.governors[provider]?.state ?? "off";
  const next = GOVERNOR_STATES[(GOVERNOR_STATES.indexOf(current) + 1) % GOVERNOR_STATES.length];
  renderGovernorControls({ [provider]: { ...state.governors[provider], state: next } }, true);
  try {
    const result = await api(API.governorToggle.method, API.governorToggle.path({ provider }), {});
    deleteSetState("machineControlPending", provider);
    renderGovernorControls(result.governors, true);
  } catch (error) {
    deleteSetState("machineControlPending", provider);
    console.error(error);
    refreshMachineControls();
  }
}
function openDrawer() {
  ui.drawer.classList.add("open");
  if (innerWidth < 1000) ui.drawerScrim.hidden = false;
  refreshMachineControls();
}
function closeDrawer() {
  if (innerWidth < 1000) ui.drawer.classList.remove("open");
  ui.drawerScrim.hidden = true;
  threadStartMenu?.collapse();
}

function uploadedFilePath(file) {
  return API.uploads.path({}, { name: file.storedName, sessionId: file.sessionId, environment: file.environment || "local" });
}

function renderAttachments() {
  ui.attachments.replaceChildren();
  for (const file of state.attachments) {
    const chip = node("div", `attachment-chip${file.uploading ? " uploading" : ""}`);
    chip.append(node("span", "attachment-name", file.uploading ? `${file.name} · uploading…` : file.name));
    const remove = node("button", "attachment-remove", "×");
    remove.type = "button"; remove.ariaLabel = `Remove ${file.name}`; remove.disabled = file.uploading;
    remove.addEventListener("click", async () => {
      file.removed = true;
      patchState({ attachments: state.attachments.filter((candidate) => candidate !== file) });
      renderAttachments(); updateComposer();
      if (file.storedName) api("DELETE", uploadedFilePath(file)).catch(() => {});
    });
    chip.append(remove); ui.attachments.append(chip);
  }
  ui.attachments.hidden = state.attachments.length === 0;
}

function clearAttachments(removeFiles = true) {
  const files = state.attachments;
  patchState({ attachmentGeneration: state.attachmentGeneration + 1, attachments: [] });
  renderAttachments(); updateComposer();
  if (removeFiles) for (const file of files) {
    file.removed = true;
    if (file.storedName) api("DELETE", uploadedFilePath(file)).catch(() => {});
  }
}

function pastedTextFileName(value) {
  const name = String(value || "").trim() || "pasted-text.txt";
  return /\.[^./\\]+$/.test(name) ? name : `${name}.txt`;
}

function openPasteTextDialog() {
  if (!state.selectedId || state.attachments.some((file) => file.uploading)) return;
  ui.pasteTextName.value = "pasted-text.txt";
  ui.pasteTextContent.value = "";
  ui.uploadPastedText.disabled = true;
  ui.pasteTextDialog.showModal();
  ui.pasteTextContent.focus();
}

async function uploadFiles(files) {
  if (!state.selectedId || !files.length) return;
  const generation = state.attachmentGeneration;
  const sessionId = state.selectedId;
  for (const source of files) {
    let file = { name: source.name || "attachment", path: null, storedName: null, sessionId, uploading: true, removed: false };
    patchState({ attachments: [...state.attachments, file] }); renderAttachments(); updateComposer();
    try {
      const response = await piFetch(API.uploads.path({}, { name: file.name, sessionId: file.sessionId }), {
        method: "POST",
        headers: { "content-type": source.type || "application/octet-stream" },
        body: source,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const pendingFile = file;
      file = { ...file, uploading: false, path: result.file.path, storedName: result.file.name, environment: result.file.environment };
      patchState({ attachments: state.attachments.map((candidate) => candidate === pendingFile ? file : candidate) });
      if (generation !== state.attachmentGeneration || file.removed) {
        api("DELETE", uploadedFilePath(file)).catch(() => {});
        patchState({ attachments: state.attachments.filter((candidate) => candidate !== file) });
      }
    } catch (error) {
      patchState({ attachments: state.attachments.filter((candidate) => candidate !== file) });
      console.error(error);
    }
    renderAttachments(); updateComposer();
  }
}

function renderVoiceState(voiceState, detail = "") {
  ui.voice.classList.toggle("connecting", voiceState === "connecting");
  ui.voice.classList.toggle("live", voiceState === "live");
  ui.voice.classList.toggle("error", voiceState === "error");
  ui.voice.ariaLabel = voiceState === "live" ? "Hang up voice" : voiceState === "connecting" ? "Voice connecting" : "Start voice";
  ui.voice.title = detail || (voiceState === "live" ? "Voice is live · select to hang up" : voiceState === "error" ? "Voice failed · select to retry" : "Start voice");
}
function stopVoice() {
  voiceSession?.stop();
  voiceSession = null;
  voiceThreadId = null;
  renderVoiceState("idle");
}
async function toggleVoice() {
  const id = state.selectedId;
  if (!id) return;
  if (voiceSession && voiceThreadId === id && ["live", "connecting"].includes(voiceSession.state)) {
    stopVoice();
    return;
  }
  if (voiceThreadId !== id) stopVoice();
  if (!voiceSession) {
    voiceThreadId = id;
    voiceSession = window.PiRemoteVoice.create({
      sessionId: id,
      onState: (next, detail) => { if (voiceThreadId === id) renderVoiceState(next, detail); },
      onNotice: (message) => {
        if (voiceThreadId === id && state.selectedId === id) { appendMessage("notice", "Voice", message); scrollBottom(); }
        else console.error(message);
      },
    });
  }
  await voiceSession.start();
}

const THREAD_VIEW_CACHE_LIMIT = 8;

function clearConversation() {
  patchState({
    lastSeq: 0, contextCapturedAt: 0, contextEntries: [], contextDocument: null, contextSessionId: null,
    sessionLiveTextDocument: null, sessionLiveThinkingDocument: null, sessionLiveDocumentId: null,
    agentLiveTextDocument: null, agentLiveThinkingDocument: null, agentDocumentRunId: null, followTail: true,
    toolCards: new Map(), userMessageLabels: new Map(),
  });
  clearAttachments(true);
  ui.transcript.replaceChildren();
  setLive("", "");
}

function stashThreadConversation() {
  const id = state.selectedId;
  if (!id || state.agentRunId) return;
  const fragment = document.createDocumentFragment();
  fragment.append(...ui.transcript.childNodes);
  const cached = {
    fragment,
    scrollTop: ui.scrollback.scrollTop,
    lastSeq: state.lastSeq,
    contextCapturedAt: state.contextCapturedAt,
    contextEntries: state.contextEntries,
    contextDocument: state.contextDocument,
    contextSessionId: state.contextSessionId,
    sessionLiveTextDocument: state.sessionLiveTextDocument,
    sessionLiveThinkingDocument: state.sessionLiveThinkingDocument,
    sessionLiveDocumentId: state.sessionLiveDocumentId,
    followTail: state.followTail,
    toolCards: state.toolCards,
    userMessageLabels: state.userMessageLabels,
  };
  const views = new Map(state.threadViews);
  views.delete(id);
  views.set(id, cached);
  while (views.size > THREAD_VIEW_CACHE_LIMIT) views.delete(views.keys().next().value);
  patchState({ threadViews: views });
}

function restoreThreadConversation(id) {
  const cached = state.threadViews.get(id);
  if (!cached) return false;
  const views = new Map(state.threadViews);
  views.delete(id);
  views.set(id, cached);
  patchState({
    threadViews: views,
    lastSeq: cached.lastSeq,
    contextCapturedAt: cached.contextCapturedAt,
    contextEntries: cached.contextEntries,
    contextDocument: cached.contextDocument,
    contextSessionId: cached.contextSessionId,
    sessionLiveTextDocument: cached.sessionLiveTextDocument,
    sessionLiveThinkingDocument: cached.sessionLiveThinkingDocument,
    sessionLiveDocumentId: cached.sessionLiveDocumentId,
    agentLiveTextDocument: null,
    agentLiveThinkingDocument: null,
    agentDocumentRunId: null,
    followTail: cached.followTail,
    toolCards: cached.toolCards,
    userMessageLabels: cached.userMessageLabels,
  });
  clearAttachments(true);
  ui.transcript.replaceChildren(cached.fragment);
  setLive(cached.sessionLiveThinkingDocument?.document || "", cached.sessionLiveTextDocument?.document || "");
  requestAnimationFrame(() => { ui.scrollback.scrollTop = cached.scrollTop; });
  return true;
}
function mergeSession(session) {
  if (!session?.id) return;
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index < 0) patchState({ sessions: [session, ...state.sessions] });
  else if (Number(session.revision || 0) >= Number(state.sessions[index].revision || 0)) patchState({ sessions: state.sessions.map((candidate, position) => position === index ? session : candidate) });
}
function applySelectedSession(session, force = false) {
  if (!session || session.id !== state.selectedId) return false;
  const revision = Number(session.revision || 0);
  if (!force && revision < state.selectedRevision) return false;
  const selectedState = session.state || "STOPPED";
  patchState({
    selectedRevision: revision, selectedName: session.name || "Agent", selectedCwd: session.cwd || "/",
    selectedState, selectedActivity: session.activity || stateActivity(selectedState), selectedTool: session.activeTool || "",
    steeringQueued: Number(session.steeringQueued || 0), followUpQueued: Number(session.followUpQueued || 0),
    queuedMessages: Array.isArray(session.queuedMessages) ? session.queuedMessages : [],
  });
  renderMessageQueue();
  return true;
}
function beginAction(id, type) {
  const action = { id, type, token: state.actionEpoch + 1 };
  patchState({ actionEpoch: action.token });
  mapState("pendingActions", id, action);
  updateChrome();
  return action;
}
function finishAction(action) {
  if (state.pendingActions.get(action.id) === action) deleteMapState("pendingActions", action.id);
  incrementState("actionEpoch");
}
// Orchestrator agents are a separate, read-only view of the same transcript
// rendering. Selecting one leaves the thread selection untouched so returning
// to a thread restores it exactly.
function selectAgent(run) {
  if (state.agentRunId === run.id) return;
  stopVoice();
  stashThreadConversation();
  patchState({ selectionEpoch: state.selectionEpoch + 1, agentRunId: run.id, agentRun: run });
  clearConversation();
  ui.empty.hidden = true;
  ui.conversation.hidden = false;
  updateChrome();
  renderThreads();
  renderAgentList();
  poll();
}
function clearAgentSelection() {
  if (!state.agentRunId) return;
  patchState({ selectionEpoch: state.selectionEpoch + 1, agentRunId: null, agentRun: null });
  clearConversation();
  renderAgentList();
}
function agentRow(run, grouped = false) {
  const row = node("button", `agent-row${grouped ? " grouped" : ""}${run.id === state.agentRunId ? " selected" : ""}`);
  row.type = "button";
  const title = node("span", "agent-row-title");
  const role = run.teamRole === "supervisor"
    ? "SUPERVISOR"
    : run.teamRole === "worker" ? `WORKER ${run.teamSlot ?? ""}`.trim() : run.label;
  title.append(
    node("span", "agent-row-label", grouped ? role : run.label),
    node("span", "agent-row-task", grouped ? run.label : run.taskId),
  );
  const status = agentActivityLabel(run);
  const meta = node("span", "agent-row-meta", `${status} · ${agentDuration(run.elapsedMs)}${run.observable ? "" : " · no transcript"}`);
  meta.style.color = run.status === "running" ? activityColor(run.activity || "WORKING") : "var(--muted)";
  row.append(title, meta);
  row.title = `${run.hostName || "This machine"} · ${run.model}${run.thinking ? `:${run.thinking}` : ""}${run.provider ? ` via ${run.provider}` : ""}`;
  row.addEventListener("click", () => { selectAgent(run); closeDrawer(); });
  return row;
}

function groupAgentRuns(runs) {
  const groups = new Map();
  const items = [];
  for (const run of runs) {
    if (!["supervisor", "worker"].includes(run.teamRole)) {
      items.push({ run });
      continue;
    }
    let group = groups.get(run.taskId);
    if (!group) {
      group = { taskId: run.taskId, runs: [] };
      groups.set(run.taskId, group);
      items.push({ group });
    }
    group.runs.push(run);
  }
  return items;
}

function teamRunOrder(left, right) {
  const role = (run) => run.teamRole === "supervisor" ? 0 : 1;
  return role(left) - role(right)
    || Number(left.teamSlot ?? 0) - Number(right.teamSlot ?? 0)
    || String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? ""));
}

function agentGroup(group, host) {
  const key = `${host.key}:${group.taskId}`;
  const runs = [...group.runs].sort(teamRunOrder);
  const selected = runs.some((run) => run.id === state.agentRunId);
  const details = node("details", `agent-group${selected ? " selected" : ""}`);
  details.open = state.agentExpandedGroups.has(key);
  const summary = node("summary", "agent-group-summary");
  const title = node("span", "agent-group-title");
  title.append(
    node("span", "agent-group-name", group.taskId),
    node("span", "agent-group-count", String(runs.length)),
  );
  const supervisors = runs.filter((run) => run.teamRole === "supervisor").length;
  const workers = runs.filter((run) => run.teamRole === "worker").length;
  const roles = [
    supervisors ? `${supervisors} supervisor${supervisors === 1 ? "" : "s"}` : "",
    workers ? `${workers} worker${workers === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  summary.append(title, node("span", "agent-group-meta", roles));
  details.append(summary, node("div", "agent-group-members"));
  const members = details.lastElementChild;
  for (const run of runs) members.append(agentRow(run, true));
  details.addEventListener("toggle", () => {
    if (details.open) addSetState("agentExpandedGroups", key);
    else deleteSetState("agentExpandedGroups", key);
  });
  return details;
}

// Agents run on more than one machine, so the list is grouped by the host that
// owns them: an empty or unreachable host is stated rather than silently
// leaving its agents out of a list that claims to hold every working agent.
function renderAgentList() {
  if (state.drawerTab !== "agents") return;
  ui.agentList.replaceChildren();
  if (state.agentError) {
    ui.agentList.append(node("div", "agent-empty", state.agentError));
    return;
  }
  const hosts = state.agentHosts.length
    ? state.agentHosts
    : [{ key: "local", name: "This machine", running: state.agentRunning, error: null }];
  for (const host of hosts) {
    const runs = state.agents.filter((run) => (run.host || "local") === host.key);
    const heading = node("div", `agent-host${host.error ? " failed" : ""}`);
    heading.append(node("span", "agent-host-name", host.name || host.label || host.key));
    heading.append(node("span", "agent-host-count", host.error ? "unreachable" : String(host.running ?? runs.length)));
    if (host.error) heading.title = host.error;
    ui.agentList.append(heading);
    if (host.error) ui.agentList.append(node("div", "agent-empty", host.error));
    else if (!runs.length) ui.agentList.append(node("div", "agent-empty", "No agents working"));
    else for (const item of groupAgentRuns(runs)) {
      ui.agentList.append(item.group ? agentGroup(item.group, host) : agentRow(item.run));
    }
  }
}
function applyAgentList(result) {
  patchState({
    agents: Array.isArray(result.runs) ? result.runs : [], agentHosts: Array.isArray(result.hosts) ? result.hosts : [],
    agentRunning: Number(result.running || 0), agentError: "",
  });
}
async function refreshAgents() {
  try { applyAgentList(await api(API.agentRuns.method, API.agentRuns.path())); }
  catch (error) { patchState({ agentError: `Agents unavailable · ${error.message}` }); }
  renderTabs();
  renderAgentList();
}
const DRAWER_TAB_KEY = "pi-remote-drawer-tab";
function restoreDrawerTab() {
  try {
    const stored = localStorage.getItem(DRAWER_TAB_KEY);
    if (["threads", "agents", "archived"].includes(stored)) patchState({ drawerTab: stored });
  } catch (error) { console.error("Could not restore the drawer tab", error); }
}
function selectDrawerTab(tab) {
  if (state.drawerTab === tab) return;
  patchState(
    { drawerTab: tab, ...(tab === "archived" ? {} : { archivedOlder: [] }) },
    [{ type: "drawer-selected", payload: tab }],
  );
  try { localStorage.setItem(DRAWER_TAB_KEY, tab); } catch (error) { console.error("Could not save the drawer tab", error); }
}
function renderTabs() {
  const failing = state.agentHostFailing || state.agentHosts.some((host) => host.error) || Boolean(state.agentError);
  const counts = {
    threads: state.sessions.length,
    agents: state.agentRunning,
    archived: Math.max(state.archivedTotal, loadedArchived().length),
  };
  for (const [tab, button, count] of [
    ["threads", ui.threadsTab, ui.threadsTabCount],
    ["agents", ui.agentsTab, ui.agentsTabCount],
    ["archived", ui.archivedTab, ui.archivedTabCount],
  ]) {
    const selected = state.drawerTab === tab;
    button.ariaSelected = String(selected);
    button.classList.toggle("attention", tab === "agents" && failing);
    count.textContent = String(counts[tab]);
  }
  ui.threadList.hidden = state.drawerTab !== "threads";
  ui.agentList.hidden = state.drawerTab !== "agents";
  ui.archivedList.hidden = state.drawerTab !== "archived";
  ui.threadsTab.ariaLabel = `Interactive agents · ${counts.threads}`;
  ui.agentsTab.ariaLabel = `Orchestrator agents · ${counts.agents}${failing ? " · a host is unreachable" : ""}`;
  ui.archivedTab.ariaLabel = `Archived threads · ${counts.archived}`;
}

function selectThread(session) {
  const changed = state.selectedId !== session.id || Boolean(state.agentRunId);
  if (state.selectedId !== session.id) stashThreadConversation();
  clearAgentSelection();
  if (changed) {
    stopVoice();
    patchState({ selectionEpoch: state.selectionEpoch + 1, selectedId: session.id, selectedRevision: Number(session.revision || 0) });
  }
  applySelectedSession(session, changed);
  if (changed) {
    if (!restoreThreadConversation(session.id)) clearConversation();
    ui.prompt.value = loadDraft(session.id);
    refreshSlashCommands();
  }
  ui.empty.hidden = true;
  ui.conversation.hidden = false;
  updateChrome();
  renderThreads();
  poll();
}
function clearSelection() {
  stopVoice();
  patchState({
    selectionEpoch: state.selectionEpoch + 1, selectedId: null, selectedName: "Agent", selectedCwd: "/", selectedState: "STOPPED",
    selectedActivity: "IDLE", selectedTool: "", selectedRevision: 0, steeringQueued: 0, followUpQueued: 0, queuedMessages: [],
  });
  renderMessageQueue();
  clearConversation(); ui.prompt.value = ""; patchState({ slashCommands: [] }); renderSlashCommands();
  ui.conversation.hidden = true; ui.empty.hidden = false;
  updateChrome();
}

function threadProvider(session) {
  return session.environment === "work" ? "work"
    : session.environment === "converge" ? "converge"
    : session.environment === "personal" ? "personal"
    : session.provider === "anthropic" ? "anthropic" : "openai";
}
function threadRow(session, archived = false) {
  const canArchive = !archived && state.archiveSupported;
  const row = node("div", `thread-row${session.id === state.selectedId && !state.agentRunId ? " selected" : ""}${archived ? " archived" : ""}${canArchive ? " can-archive" : ""}`);
  row.dataset.motionKey = `${archived ? "archived" : "active"}:${session.id}`;
  const open = node(archived ? "div" : "button", "thread-open");
  if (!archived) open.type = "button";
  open.append(node("span", "thread-name", session.name || "Agent"));
  const meta = node("span", "thread-meta");
  const provider = threadProvider(session);
  const providerIcon = node("img", "thread-provider");
  providerIcon.src = `/${provider}.svg`;
  providerIcon.alt = provider === "work" ? "Work" : provider === "converge" ? "Cloud" : provider === "personal" ? "Personal" : provider === "anthropic" ? "Anthropic" : "OpenAI";
  providerIcon.title = `${providerIcon.alt} thread`;
  const activity = archived ? "IDLE" : session.activity;
  const status = node("span", "thread-state", archived ? "ARCHIVED" : activityLabel(session.activity, session.activeTool));
  status.style.color = activityColor(activity);
  meta.append(providerIcon, status);
  open.append(meta);
  if (archived) {
    const action = node("button", "unarchive-thread", "Unarchive");
    action.type = "button"; action.ariaLabel = `Unarchive thread ${session.name}`;
    action.addEventListener("click", () => unarchiveThread(session));
    row.append(open, action);
  } else {
    open.addEventListener("click", () => { selectThread(session); closeDrawer(); });
    row.append(open);
    if (canArchive) {
      const action = node("button", "archive-thread", "×");
      action.type = "button"; action.ariaLabel = `Archive thread ${session.name}`;
      action.title = `Archive ${session.name}`;
      action.addEventListener("click", async () => {
        action.disabled = true;
        action.textContent = "…";
        if (!await archiveThread(session)) {
          action.disabled = false;
          action.textContent = "×";
        }
      });
      row.append(action);
    }
  }
  return row;
}
function loadedArchived() {
  const byId = new Map();
  for (const session of [...state.archivedSessions, ...state.archivedOlder]) if (!byId.has(session.id)) byId.set(session.id, session);
  return [...byId.values()];
}
async function loadOlderArchived() {
  if (state.archivedLoading) return;
  patchState({ archivedLoading: true });
  renderThreads();
  try {
    const offset = loadedArchived().length;
    const page = await api(API.archivedSessions.method, API.archivedSessions.path({}, { offset, limit: ARCHIVED_PAGE_SIZE }));
    const known = new Set(loadedArchived().map((session) => session.id));
    patchState({
      archivedOlder: [...state.archivedOlder, ...(page.sessions || []).filter((session) => !known.has(session.id))],
      ...(Number.isFinite(page.total) ? { archivedTotal: Number(page.total) } : {}),
    });
  } catch (error) { console.error(error); }
  finally { patchState({ archivedLoading: false }); renderTabs(); renderThreads(); }
}
function replaceAnimatedRows(container, rows, emptyText) {
  const previous = new Map([...container.querySelectorAll("[data-motion-key]")]
    .map((row) => [row.dataset.motionKey, row.getBoundingClientRect()]));
  container.replaceChildren(...(rows.length ? rows : [node("div", "agent-empty", emptyText)]));
  requestAnimationFrame(() => {
    let entering = 0;
    for (const row of container.querySelectorAll("[data-motion-key]")) {
      const before = previous.get(row.dataset.motionKey);
      const after = row.getBoundingClientRect();
      if (before) {
        const delta = before.top - after.top;
        setMotion(row, { y: delta, opacity: 1 });
        if (Math.abs(delta) > 0.5) springMotion(row, { y: 0 }, 550, 0.9);
      } else {
        setMotion(row, { x: -18, opacity: 0 });
        const delay = entering++ * 38;
        setTimeout(() => {
          if (row.isConnected) springMotion(row, { x: 0, opacity: 1 }, 900, 0.58);
        }, delay);
      }
    }
  });
}

function renderThreads() {
  if (state.drawerTab === "threads") {
    replaceAnimatedRows(ui.threadList, state.sessions.map((session) => threadRow(session)), "No threads");
    return;
  }
  if (state.drawerTab !== "archived") return;
  const archived = loadedArchived();
  const total = Math.max(state.archivedTotal, archived.length);
  replaceAnimatedRows(ui.archivedList, archived.map((session) => threadRow(session, true)), "No archived threads");
  if (!total || archived.length >= total) return;
  const more = node("button", "archived-more", state.archivedLoading ? "Loading older threads…" : `Show older · ${total - archived.length} more`);
  more.type = "button";
  more.disabled = state.archivedLoading;
  more.addEventListener("click", loadOlderArchived);
  ui.archivedList.append(more);
}

function renderAgents(agents) {
  const locations = new Map((agents?.locations || []).map((location) => [location.key, location]));
  const location = locations.values().next().value;
  patchState({ agentModelCounts: new Map((location?.models || []).map((model) => [model.key, Number(model.count || 0)])) });
  renderCapacityRows();
  // Every thread poll carries the same fleet-wide running count the agent list
  // returns, so the tab stays honest without fetching a list nobody is reading.
  patchState({
    ...(Number.isFinite(agents?.sources?.orchestrator) ? { agentRunning: Number(agents.sources.orchestrator) } : {}),
    agentHostFailing: [...locations.values()].some((candidate) => Boolean(candidate.error)),
  });
}

function updateUsageSummary() {
  ui.usageSummary.textContent = state.machineUsageText;
  ui.usageSummary.style.color = state.machineUsageColor;
  ui.usageSummary.title = state.machineUsageDescription;
}
function renderCapacityRows() {
  ui.planSummary.replaceChildren();
  const descriptions = [];
  for (const card of state.planCards) for (const metric of card.metrics || []) {
    if (metric.text === "—") continue;
    const count = state.agentModelCounts.get(metric.model) || 0;
    const row = document.createElement("div");
    row.className = "capacity-row";
    const icon = document.createElement("img");
    icon.src = `/${encodeURIComponent(card.icon)}.svg`;
    icon.alt = card.label;
    const model = document.createElement("span");
    model.className = "capacity-model";
    model.textContent = metric.modelLabel;
    const inUse = document.createElement("span");
    inUse.className = "capacity-count";
    inUse.textContent = String(count);
    const value = document.createElement("span");
    value.className = "capacity-value";
    value.textContent = metric.text;
    const description = `${card.label} ${metric.modelLabel}, ${count} in use, ${metric.description}`;
    row.title = description;
    row.ariaLabel = description;
    descriptions.push(description);
    row.append(icon, model, inUse, value);
    ui.planSummary.append(row);
  }
  const description = descriptions.join(". ") || "Plan capacity unavailable";
  ui.planSummary.title = description;
  ui.planSummary.ariaLabel = description;
}
function renderPlan(plans) {
  patchState({ planCards: Array.isArray(plans?.cards) ? plans.cards : [] });
  renderCapacityRows();
}
function renderMachine(machine) {
  if (!machine) {
    const text = "CPU — · GPU — · RAM — · DISK —";
    patchState({ machineUsageText: text, machineUsageDescription: text, machineUsageColor: "var(--muted)" });
    updateUsageSummary(); return;
  }
  const percent = (value) => value === null || value === undefined ? "—" : `${value}%`;
  const cpu = percent(machine.cpuPercent);
  const gpu = percent(machine.gpuPercent);
  const ram = percent(machine.memory?.percentUsed);
  const disk = percent(machine.disk?.percentUsed);
  const text = `CPU ${cpu} · GPU ${gpu} · RAM ${ram} · DISK ${disk}`;
  const gib = (bytes) => `${(Number(bytes || 0) / 1073741824).toFixed(1)} GiB`;
  let description = text;
  if (machine.memory) description += `. RAM ${gib(machine.memory.usedBytes)} of ${gib(machine.memory.totalBytes)}`;
  if (machine.disk) description += `. Disk ${gib(machine.disk.usedBytes)} of ${gib(machine.disk.totalBytes)}`;
  patchState({
    machineUsageText: text, machineUsageDescription: description,
    machineUsageColor: (machine.memory?.percentUsed ?? 0) >= 90 || (machine.disk?.percentUsed ?? 0) >= 90 ? "var(--danger)" : "var(--muted)",
  });
  updateUsageSummary();
}

async function poll(immediate = false) {
  if (state.pollBusy) {
    patchState({ pollAgain: true });
    state.pollController?.abort();
    return;
  }
  const controller = new AbortController();
  patchState({ pollBusy: true, pollController: controller });
  const requested = state.selectedId;
  const requestedAgent = state.agentRunId;
  const after = state.lastSeq;
  const selectionEpoch = state.selectionEpoch;
  const actionEpoch = state.actionEpoch;
  const requestedContext = requested && state.contextSessionId === requested ? state.contextDocument : null;
  const requestedSessionText = requested && state.sessionLiveDocumentId === requested ? state.sessionLiveTextDocument : null;
  const requestedSessionThinking = requested && state.sessionLiveDocumentId === requested ? state.sessionLiveThinkingDocument : null;
  const requestedAgentText = requestedAgent && state.agentDocumentRunId === requestedAgent ? state.agentLiveTextDocument : null;
  const requestedAgentThinking = requestedAgent && state.agentDocumentRunId === requestedAgent ? state.agentLiveThinkingDocument : null;
  let retryDelay = 0;
  try {
    const body = {
      after: state.syncSeq,
      waitMs: immediate ? 0 : 25_000,
      contextProjection: "display",
      includeArchived: true,
      includeAgentList: state.drawerTab === "agents" || Boolean(requestedAgent),
      includeDashboard: true,
    };
    if (requested && !requestedAgent) {
      body.selectedId = requested;
      body.eventSessionId = requested;
      body.eventAfter = Number.MAX_SAFE_INTEGER;
      if (requestedContext) body.contextHash = requestedContext.hash;
      if (requestedSessionText) body.eventLiveTextHash = requestedSessionText.hash;
      if (requestedSessionThinking) body.eventLiveThinkingHash = requestedSessionThinking.hash;
    }
    if (requestedAgent) {
      body.agentRunId = requestedAgent;
      body.agentAfter = after;
      if (requestedAgentText) body.agentLiveTextHash = requestedAgentText.hash;
      if (requestedAgentThinking) body.agentLiveThinkingHash = requestedAgentThinking.hash;
    }
    const all = await syncRequest(body, controller.signal);
    if (controller.signal.aborted) throw new DOMException("Synchronization cancelled", "AbortError");

    if (state.syncEpoch && state.syncEpoch !== all.epoch) {
      patchState({
        contextDocument: null, contextSessionId: null, threadViews: new Map(),
        sessionLiveTextDocument: null, sessionLiveThinkingDocument: null, sessionLiveDocumentId: null,
        agentLiveTextDocument: null, agentLiveThinkingDocument: null, agentDocumentRunId: null, syncSeq: 0,
      });
    }
    patchState({ syncEpoch: String(all.epoch || "") });

    if (all.agentRuns) applyAgentList(all.agentRuns);
    const sameAgent = requestedAgent && requestedAgent === state.agentRunId && selectionEpoch === state.selectionEpoch;
    if (all.agentEvents && sameAgent) {
      const baseText = state.agentDocumentRunId === requestedAgent ? state.agentLiveTextDocument : null;
      const baseThinking = state.agentDocumentRunId === requestedAgent ? state.agentLiveThinkingDocument : null;
      const nextText = await window.PiRemoteSync.update(baseText, all.agentEvents.liveTextUpdate);
      const nextThinking = await window.PiRemoteSync.update(baseThinking, all.agentEvents.liveThinkingUpdate);
      if (controller.signal.aborted) throw new DOMException("Synchronization cancelled", "AbortError");
      patchState({
        agentLiveTextDocument: nextText, agentLiveThinkingDocument: nextThinking, agentDocumentRunId: requestedAgent,
        ...(all.agentEvents.run ? { agentRun: all.agentEvents.run } : {}),
      });
      renderEvents({
        ...all.agentEvents,
        liveText: nextText?.document || "",
        liveThinking: nextThinking?.document || "",
      });
    }
    renderAgentList();

    const previous = new Map([...state.sessions, ...state.archivedSessions].map((session) => [session.id, session]));
    const mergeListed = (sessions) => (sessions || []).map((session) => {
      const old = previous.get(session.id);
      return old && Number(old.revision || 0) > Number(session.revision || 0) ? old : session;
    });
    const sessions = mergeListed(all.sessions);
    const archivedSessions = mergeListed(all.archivedSessions);
    const listedArchived = new Set(archivedSessions.map((session) => session.id));
    const liveIds = new Set(sessions.map((session) => session.id));
    patchState({
      archiveSupported: true, sessions, archivedSessions,
      archivedOlder: state.archivedOlder.filter((session) => !listedArchived.has(session.id) && !liveIds.has(session.id)),
      archivedTotal: Number.isFinite(all.archivedTotal) ? Number(all.archivedTotal) : archivedSessions.length,
    });
    const sameSelection = selectionEpoch === state.selectionEpoch && requested === state.selectedId && !state.agentRunId;
    const mutationStable = actionEpoch === state.actionEpoch && !selectedPendingAction();
    let synchronizedLive = null;
    if (sameSelection && all.sessionEvents) {
      const baseText = state.sessionLiveDocumentId === requested ? state.sessionLiveTextDocument : null;
      const baseThinking = state.sessionLiveDocumentId === requested ? state.sessionLiveThinkingDocument : null;
      const nextText = await window.PiRemoteSync.update(baseText, all.sessionEvents.liveTextUpdate);
      const nextThinking = await window.PiRemoteSync.update(baseThinking, all.sessionEvents.liveThinkingUpdate);
      if (controller.signal.aborted) throw new DOMException("Synchronization cancelled", "AbortError");
      patchState({
        sessionLiveTextDocument: nextText,
        sessionLiveThinkingDocument: nextThinking,
        sessionLiveDocumentId: requested,
      });
      synchronizedLive = { text: nextText?.document || "", thinking: nextThinking?.document || "" };
    }
    if (sameSelection && mutationStable) {
      const selected = all.selectedSession || state.sessions.find((session) => session.id === requested);
      if (selected) applySelectedSession(selected);
      else if (requested) clearSelection();
    }
    if (sameSelection && all.contextUpdate) {
      const base = state.contextSessionId === requested ? state.contextDocument : null;
      const next = await window.PiRemoteSync.update(base, all.contextUpdate);
      if (controller.signal.aborted) throw new DOMException("Synchronization cancelled", "AbortError");
      patchState({ contextDocument: next, contextSessionId: requested });
      if (all.selectedSession) mergeSession(all.selectedSession);
      if (mutationStable && all.selectedSession) applySelectedSession(all.selectedSession);
      renderContext({
        capturedAt: next?.capturedAt || 0,
        context: next ? JSON.parse(next.document) : null,
        session: all.selectedSession,
      });
    }
    if (synchronizedLive) setLive(synchronizedLive.thinking, synchronizedLive.text);
    patchState({ syncSeq: Number(all.seq || state.syncSeq) });
    if (!state.selectedId && !state.agentRunId && state.sessions.length && selectionEpoch === state.selectionEpoch) selectThread(state.sessions[0]);
    renderThreads();
    if (all.agents) renderAgents(all.agents);
    renderTabs();
    if (all.plans) renderPlan(all.plans);
    if (all.governors) renderGovernorControls(all.governors);
    if (all.machine) renderMachine(all.machine);
    updateChrome();
    ui.connection.hidden = true;
  } catch (error) {
    if (error?.name !== "AbortError") {
      patchState({ syncSeq: 0 });
      retryDelay = 1_200;
      ui.connection.hidden = false;
      ui.connection.textContent = `●  Offline · ${error.message}`; ui.connection.style.color = "var(--danger)";
      ui.topState.textContent = "OFFLINE"; ui.topState.style.color = "var(--danger)";
    }
  } finally {
    const again = state.pollAgain;
    patchState({ ...(state.pollController === controller ? { pollController: null } : {}), pollBusy: false, pollAgain: false });
    setTimeout(() => poll(again), again ? 0 : retryDelay);
  }
}

function appendMessage(kind, label, text, eventSeq = 0) {
  const item = node("div", `message ${kind}`);
  const body = node("div", "markdown-body");
  const labelNode = node("span", "message-label", label.toUpperCase());
  item.append(labelNode, body);
  if (kind === "user" && eventSeq) {
    item.dataset.eventSeq = String(eventSeq);
    mapState("userMessageLabels", Number(eventSeq), labelNode);
  }
  renderMarkdown(body, text);
  ui.transcript.append(item); trimTranscript();
  return item;
}
function appendThinking(text) { appendMessage("thinking", "Thinking", text); }
function trimTranscript() {
  if (!state.agentRunId) return;
  while (ui.transcript.children.length > 50) {
    const first = ui.transcript.firstElementChild;
    for (const [id, card] of state.toolCards) if (card.root === first) deleteMapState("toolCards", id);
    if (first?.dataset.eventSeq) deleteMapState("userMessageLabels", Number(first.dataset.eventSeq));
    first?.remove();
  }
}
function nearConversationBottom() {
  return ui.scrollback.scrollHeight - ui.scrollback.scrollTop - ui.scrollback.clientHeight <= 80;
}
function scrollBottom() {
  if (!state.followTail) return;
  requestAnimationFrame(() => {
    if (state.followTail) ui.scrollback.scrollTop = ui.scrollback.scrollHeight;
  });
}
let pendingLiveRender = null;
let liveRenderFrame = 0;
function setLive(thinking, answer) {
  pendingLiveRender = { thinking, answer, selectionEpoch: state.selectionEpoch };
  if (liveRenderFrame) return;
  liveRenderFrame = requestAnimationFrame(() => {
    liveRenderFrame = 0;
    const next = pendingLiveRender;
    pendingLiveRender = null;
    if (!next || next.selectionEpoch !== state.selectionEpoch) return;
    ui.liveThinking.textContent = next.thinking;
    ui.liveThinking.hidden = !next.thinking;
    ui.liveAnswer.textContent = next.answer;
    ui.liveAnswer.hidden = !next.answer;
    if (next.thinking || next.answer) scrollBottom();
  });
}

function shortPath(path = "") {
  const home = state.home;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
function formatJson(value) { try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value ?? ""); } }
function toolSummary(name, args) {
  const tool = (name || "tool").toLowerCase();
  const path = args.path || args.file_path || "";
  if (tool === "bash") return `$ ${args.command || ""}`;
  if (tool === "read") {
    const start = args.offset ?? 1;
    const range = args.offset !== undefined || args.limit !== undefined ? `:${start}${args.limit !== undefined ? `-${start + args.limit - 1}` : ""}` : "";
    return `read ${shortPath(path)}${range}`;
  }
  if (tool === "edit") return `edit ${shortPath(path)}${Array.isArray(args.edits) && args.edits.length > 1 ? ` · ${args.edits.length} changes` : ""}`;
  if (tool === "write") return `write ${shortPath(path)}`;
  return tool;
}
function toolInput(name, args) {
  const tool = (name || "").toLowerCase();
  if (tool === "write") return args.content || "";
  if (tool === "edit" && Array.isArray(args.edits)) return args.edits.slice(0, 3).map((edit) => `− ${edit.oldText || ""}\n+ ${edit.newText || ""}`).join("\n");
  return ["bash", "read", "grep", "find", "ls"].includes(tool) ? "" : formatJson(args);
}
function eventMillis(value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : Date.now(); }
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function updateToolTiming(card) {
  const end = card.finished ? card.endedAt : Date.now();
  const started = new Date(card.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  card.timing.textContent = `Started ${started} · ${card.finished ? "ran" : "elapsed"} ${duration(end - card.startedAt)} · ${card.timeout >= 0 ? `timeout ${duration(card.timeout)}` : "no timeout"}`;
}
function startTool(event) {
  const id = event.toolCallId || crypto.randomUUID();
  if (state.toolCards.has(id)) return state.toolCards.get(id);
  const args = event.args || {};
  const root = node("div", "tool-card collapsed");
  const header = node("pre", "tool-header", `…  ${toolSummary(event.name, args)}`);
  const timing = node("div", "tool-timing");
  const body = node("pre", "tool-body", toolInput(event.name, args));
  if (!body.textContent) body.hidden = true;
  const toggle = node("button", "tool-toggle", "Show more"); toggle.type = "button";
  const expandable = header.textContent.length > 100 || body.textContent.length > 320 || body.textContent.split("\n").length > 5;
  toggle.hidden = !expandable;
  toggle.addEventListener("click", () => {
    const collapsed = root.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "Show more" : "Show less";
  });
  root.append(header, timing, body, toggle); ui.transcript.append(root); trimTranscript();
  const timeout = args.timeoutMs !== undefined ? Math.max(0, Number(args.timeoutMs)) : args.timeout !== undefined ? Math.max(0, Number(args.timeout) * 1000) : -1;
  const card = { root, header, timing, body, toggle, startedAt: eventMillis(event.time), endedAt: 0, timeout, finished: false };
  mapState("toolCards", id, card); updateToolTiming(card); return card;
}
function finishTool(event) {
  const card = state.toolCards.get(event.toolCallId) || startTool(event);
  card.finished = true; card.endedAt = eventMillis(event.time);
  card.root.classList.add(event.error ? "error" : "success");
  card.header.textContent = `${event.error ? "×" : "✓"}  ${card.header.textContent.replace(/^…\s+/, "")}`;
  const output = (event.output || "").trim();
  if (output) { card.body.textContent = `${card.body.textContent ? `${card.body.textContent}\n\n` : ""}${output}`; card.body.hidden = false; }
  const expandable = card.header.textContent.length > 100 || card.body.textContent.length > 320 || card.body.textContent.split("\n").length > 5;
  card.toggle.hidden = !expandable; updateToolTiming(card);
}

function fencedContext(value, language = "json") {
  const text = String(value ?? "");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
function contextContentMarkdown(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fencedContext(formatJson(content));
  return content.map((block) => {
    if (!block || typeof block !== "object") return fencedContext(formatJson(block));
    if (block.type === "text") return String(block.text || "");
    if (block.type === "thinking") return `*Thinking*\n\n${String(block.thinking || "")}`;
    if (block.type === "image") {
      const mime = String(block.mimeType || "application/octet-stream");
      const data = String(block.data || "");
      return data ? `![Context image](data:${mime};base64,${data})` : `*Image · ${mime}*`;
    }
    if (block.type === "toolCall") {
      const namespace = block.namespace ? `${block.namespace}.` : "";
      return `**Tool call · ${namespace}${String(block.name || "tool")}**\n\n${fencedContext(formatJson(block.arguments))}`;
    }
    return fencedContext(formatJson(block));
  }).filter(Boolean).join("\n\n");
}
function modelContextEntries(context) {
  if (!context) return [{ key: "waiting", signature: "waiting", kind: "notice", label: "Context", text: "Context will appear when Pi makes its next model request." }];
  const entries = [{
    key: "system",
    signature: `system:${context.systemPrompt || ""}`,
    kind: "system",
    label: "System",
    text: String(context.systemPrompt || ""),
  }];
  for (const [index, tool] of (context.tools || []).entries()) {
    entries.push({
      key: `tool:${index}:${tool.name || "tool"}`,
      signature: `tool:${JSON.stringify(tool)}`,
      kind: "tool",
      label: `Tool · ${tool.name || "tool"}`,
      text: `${String(tool.description || "")}\n\n${fencedContext(formatJson(tool.parameters))}`.trim(),
    });
  }
  const results = new Map((context.messages || [])
    .filter((message) => message?.role === "toolResult")
    .map((message) => [String(message.toolCallId || ""), message]));
  const pairedResults = new Set();
  for (const [messageIndex, message] of (context.messages || []).entries()) {
    const role = String(message?.role || "message");
    if (role === "assistant" && Array.isArray(message.content)) {
      for (const [blockIndex, block] of message.content.entries()) {
        if (block?.type === "toolCall") {
          const result = results.get(String(block.id || ""));
          if (result) pairedResults.add(result);
          entries.push({
            key: `toolCall:${block.id || `${message.timestamp || messageIndex}:${blockIndex}`}`,
            signature: `toolCall:${JSON.stringify(block)}:${JSON.stringify(result || null)}`,
            kind: "toolCall",
            toolCall: block,
            toolResult: result,
            time: message.timestamp,
          });
        } else if (block?.type === "thinking") {
          entries.push({ key: `assistant:${message.timestamp || messageIndex}:${blockIndex}:thinking`, signature: `thinking:${JSON.stringify(block)}`, kind: "thinking", label: "Thinking", text: String(block.thinking || "") });
        } else {
          entries.push({ key: `assistant:${message.timestamp || messageIndex}:${blockIndex}:${block?.type || "content"}`, signature: `assistant:${JSON.stringify(block)}`, kind: "assistant", label: "Assistant", text: contextContentMarkdown([block]) });
        }
      }
      if (message.content.length === 0 && message.errorMessage) entries.push({
        key: `assistant:${message.timestamp || messageIndex}:error`,
        signature: `assistant-error:${message.errorMessage}`,
        kind: "notice",
        label: "Assistant error",
        text: String(message.errorMessage),
      });
      continue;
    }
    if (role === "toolResult" && pairedResults.has(message)) continue;
    entries.push({
      key: `message:${role}:${message?.timestamp || messageIndex}:${message?.toolCallId || ""}`,
      signature: `message:${JSON.stringify(message)}`,
      kind: role === "user" ? "user" : role === "assistant" ? "assistant" : role === "toolResult" && message?.isError ? "notice" : "tool",
      label: role === "user" ? "User" : role === "assistant" ? "Assistant" : role === "toolResult" ? `Tool result · ${message.toolName || "tool"}` : role,
      text: contextContentMarkdown(message?.content),
    });
  }
  return entries;
}
function appendContextEntry(entry) {
  if (entry.kind !== "toolCall") return appendMessage(entry.kind, entry.label, entry.text);
  const call = entry.toolCall;
  const event = { toolCallId: call.id, name: call.name, args: call.arguments || {}, time: new Date(Number(entry.time || Date.now())).toISOString() };
  const card = startTool(event);
  if (entry.toolResult) finishTool({
    ...event,
    output: contextContentMarkdown(entry.toolResult.content),
    error: Boolean(entry.toolResult.isError),
    time: new Date(Number(entry.toolResult.timestamp || entry.time || Date.now())).toISOString(),
  });
  return card.root;
}
function renderContext(result) {
  const capturedAt = Number(result.capturedAt || 0);
  if (capturedAt === state.contextCapturedAt && state.contextEntries.length) return;
  const entries = modelContextEntries(result.context);
  let shared = 0;
  while (shared < entries.length && shared < state.contextEntries.length
    && entries[shared].signature === state.contextEntries[shared].signature) shared++;
  while (shared < entries.length && shared < state.contextEntries.length
    && entries[shared].key === state.contextEntries[shared].key && entries[shared].kind !== "toolCall") {
    const root = ui.transcript.children[shared];
    if (root) {
      root.className = `message ${entries[shared].kind}`;
      const label = root.querySelector(".message-label");
      if (label) label.textContent = entries[shared].label.toUpperCase();
      const body = root.querySelector(".markdown-body");
      if (body) renderMarkdown(body, entries[shared].text);
    }
    shared++;
  }
  while (state.contextEntries.length > shared) {
    const removed = state.contextEntries.pop();
    if (removed.kind === "toolCall") deleteMapState("toolCards", String(removed.toolCall.id || ""));
    ui.transcript.lastElementChild?.remove();
  }
  for (let index = shared; index < entries.length; index++) appendContextEntry(entries[index]);
  patchState({ contextCapturedAt: capturedAt, contextEntries: entries });
  setLive("", "");
  if (shared < entries.length) scrollBottom();
}

function renderEvents(result) {
  let added = false;
  for (const event of result.events || []) {
    patchState({ lastSeq: Math.max(state.lastSeq, Number(event.seq) || 0) });
    if (event.type === "user") {
      const label = event.delivery === "steer" ? "You · Steer" : event.delivery === "followUp" ? "You · Later" : "You";
      appendMessage("user", label, event.text, event.seq);
    }
    else if (event.type === "user_delivery") {
      const label = state.userMessageLabels.get(Number(event.eventSeq));
      if (label) label.textContent = event.delivery === "steer" ? "YOU · STEER" : "YOU · LATER";
    }
    else if (event.type === "assistant") appendMessage("assistant", "Pi", event.text);
    else if (event.type === "thinking") appendThinking(event.text);
    else if (event.type === "notice") appendMessage("notice", "Status", event.text);
    else if (event.type === "tool_start") startTool(event);
    else if (event.type === "tool_end") finishTool(event);
    added = true;
  }
  setLive(result.liveThinking || "", result.liveText || "");
  if (added) scrollBottom();
}
setInterval(() => { for (const card of state.toolCards.values()) if (!card.finished) updateToolTiming(card); }, 1000);

async function newThread(destination, model) {
  try {
    const result = await api(API.createSession.method, API.createSession.path(), { requestId: crypto.randomUUID(), destination, model });
    selectThread(result.session); closeDrawer();
  } catch (error) { console.error(error); }
}

function glyphOn(accent) {
  const color = /^#[0-9a-f]{6}$/i.test(accent || "") ? accent : "#89b4fa";
  const [red, green, blue] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.5 ? "#f2f4f6" : "#0b0f14";
}

class ThreadStartMenu {
  constructor(root) {
    this.root = root;
    this.destinations = [];
    this.destinationPairs = [];
    this.modelPairs = [];
    this.chosen = null;
    this.expanded = false;
    this.animationVersion = 0;
    this.shapes = node("div", "new-thread-shapes");
    this.faces = node("div", "new-thread-faces");
    root.replaceChildren(this.shapes, this.faces);
    this.trigger = this.pair({ accent: "#89b4fa", label: "New thread" }, true, 44);
    this.trigger.face.disabled = true;
    this.trigger.face.addEventListener("click", () => this.expanded ? this.collapse() : this.open());
    document.addEventListener("pointerdown", (event) => {
      if (this.expanded && !this.root.contains(event.target)) this.collapse();
    }, true);
  }

  pair(choice, trigger, size) {
    const shape = node("span", "thread-start-shape");
    const face = node("button", `provider-button${trigger ? " trigger" : ""}`);
    shape.dataset.motionCentered = "true";
    face.dataset.motionCentered = "true";
    shape.style.width = face.style.width = `${size}px`;
    shape.style.height = face.style.height = `${size}px`;
    const edge = (44 - size) / 2;
    shape.style.right = face.style.right = `${edge}px`;
    shape.style.background = choice.accent || "#89b4fa";
    face.type = "button";
    face.ariaLabel = trigger ? "New thread" : choice.label;
    face.title = face.ariaLabel;
    const glyph = node("span", "glyph");
    const onColor = glyphOn(choice.accent);
    if (trigger) glyph.style.setProperty("--glyph-color", onColor);
    else {
      const icon = node("img");
      icon.src = `/${choice.icon}.svg`;
      icon.alt = "";
      icon.draggable = false;
      glyph.classList.toggle("dark", onColor === "#0b0f14");
      glyph.append(icon);
    }
    face.append(glyph);
    this.shapes.append(shape);
    this.faces.append(face);
    setMotion(shape, { x: 0, y: 0, scale: trigger ? 1 : 0, opacity: 1 });
    setMotion(face, { x: 0, y: 0, scale: trigger ? 1 : 0, opacity: trigger ? 1 : 0 });
    setMotion(glyph, { scale: 1 });
    face.addEventListener("pointerdown", () => springMotion(glyph, { scale: 0.86 }, 2600, 0.62));
    for (const event of ["pointerup", "pointercancel", "pointerleave"])
      face.addEventListener(event, () => springMotion(glyph, { scale: 1 }, 2600, 0.62));
    return { shape, face, glyph, choice, target: 0 };
  }

  setDestinations(destinations) {
    this.collapse(true);
    this.destinations = destinations || [];
    this.trigger.face.disabled = this.destinations.length === 0;
  }

  open() {
    if (this.expanded || !this.destinations.length) return;
    this.expanded = true;
    this.chosen = null;
    const version = ++this.animationVersion;
    this.root.classList.add("expanded");
    this.trigger.face.disabled = true;
    springMotion(this.trigger.shape, { scale: 0 }, 380, 0.62);
    springMotion(this.trigger.face, { scale: 0, opacity: 0 }, 900, 1);
    springMotion(ui.drawerTabs, { scale: 0.82, opacity: 0 }, 900, 1);
    ui.drawerTabs.style.pointerEvents = "none";
    this.showRow(this.destinations, 0, "destination", version);
  }

  collapse(force = false) {
    if (!this.expanded && !force) return;
    this.expanded = false;
    this.chosen = null;
    const version = ++this.animationVersion;
    this.root.classList.remove("expanded");
    for (const pair of [...this.destinationPairs, ...this.modelPairs]) {
      pair.face.disabled = true;
      springMotion(pair.shape, { x: 0, y: 0, scale: 0 }, 900, 1);
      springMotion(pair.face, { x: 0, y: 0, scale: 0, opacity: 0 }, 900, 1);
    }
    springMotion(this.trigger.shape, { scale: 1 }, 900, 0.7);
    springMotion(this.trigger.face, { scale: 1, opacity: 1 }, 900, 0.55);
    springMotion(ui.drawerTabs, { scale: 1, opacity: 1 }, 900, 0.55);
    ui.drawerTabs.style.pointerEvents = "";
    setTimeout(() => {
      if (version !== this.animationVersion) return;
      this.clearPairs(this.destinationPairs);
      this.clearPairs(this.modelPairs);
      this.destinationPairs = [];
      this.modelPairs = [];
      this.shapes.classList.remove("moving");
      this.trigger.face.disabled = this.destinations.length === 0;
    }, reducedMotion.matches ? 0 : 520);
  }

  clearPairs(pairs) {
    for (const pair of pairs) { pair.shape.remove(); pair.face.remove(); }
  }

  showRow(choices, origin, stage, version) {
    const count = choices.length;
    const gap = 14;
    const available = this.root.clientWidth - gap * Math.max(0, count - 1);
    const size = Math.max(32, Math.min(46, Math.floor(available / Math.max(1, count))));
    const pairs = choices.map((choice, index) => {
      const pair = this.pair(choice, false, size);
      pair.target = -(count - 1 - index) * (size + gap);
      pair.face.ariaLabel = stage === "model"
        ? `Start a ${this.chosen.label} thread on ${choice.label}`
        : choice.models?.length ? `${choice.label} threads` : `Start a ${choice.label} thread`;
      pair.face.title = pair.face.ariaLabel;
      pair.face.addEventListener("click", () => stage === "model" ? this.chooseModel(pair) : this.chooseDestination(pair));
      setMotion(pair.shape, { x: origin, y: 0, scale: 0, opacity: 1 });
      setMotion(pair.face, { x: origin, y: 0, scale: 0, opacity: 0 });
      setTimeout(() => {
        if (!this.expanded || version !== this.animationVersion) return;
        springMotion(pair.shape, { x: pair.target, scale: 1 }, 380, 0.62);
        springMotion(pair.face, { x: pair.target, scale: 1, opacity: 1 }, 900, 0.5);
      }, reducedMotion.matches ? 0 : index * 45);
      return pair;
    });
    if (stage === "model") this.modelPairs = pairs;
    else this.destinationPairs = pairs;
    this.shapes.classList.add("moving");
    setTimeout(() => {
      if (version === this.animationVersion) this.shapes.classList.remove("moving");
    }, reducedMotion.matches ? 0 : count * 45 + 620);
  }

  chooseDestination(pair) {
    if (!this.expanded) return;
    const destination = pair.choice;
    if (!destination.models?.length) {
      this.collapse();
      newThread(destination.id, null);
      return;
    }
    this.chosen = destination;
    const version = ++this.animationVersion;
    this.shapes.classList.add("moving");
    for (const candidate of this.destinationPairs) {
      candidate.face.disabled = true;
      if (candidate === pair) {
        springMotion(candidate.shape, { scale: 0 }, 380, 1);
        springMotion(candidate.face, { scale: 0, opacity: 0 }, 900, 1);
      } else {
        springMotion(candidate.shape, { y: 150, scale: 0 }, 520, 1);
        springMotion(candidate.face, { y: 150, scale: 0, opacity: 0 }, 150, 1);
      }
    }
    this.showRow(destination.models, pair.target, "model", version);
  }

  chooseModel(pair) {
    if (!this.expanded || !this.chosen) return;
    const destination = this.chosen.id;
    const model = pair.choice.id;
    this.collapse();
    newThread(destination, model);
  }
}

async function loadThreadStarts() {
  if (!threadStartMenu) threadStartMenu = new ThreadStartMenu(ui.newThreadButtons);
  try {
    const starts = await api(API.threadStarts.method, API.threadStarts.path());
    patchState({ ...(starts.home ? { home: starts.home } : {}), threadStarts: starts.destinations || [] });
    threadStartMenu.setDestinations(state.threadStarts);
  } catch (error) { console.error("Could not load thread destinations", error); }
}
async function archiveThread(session) {
  if (!state.archiveSupported) return false;
  try {
    await api(API.archiveSession.method, API.archiveSession.path({ sessionId: session.id }));
    const views = new Map(state.threadViews);
    views.delete(session.id);
    patchState({ threadViews: views });
    if (state.selectedId === session.id) clearSelection();
    await poll();
    return true;
  } catch (error) { console.error(error); return false; }
}
async function unarchiveThread(session) {
  try {
    const result = await api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: session.id }), {});
    patchState({ archivedOlder: state.archivedOlder.filter((older) => older.id !== session.id) });
    if (result.session) selectThread(result.session);
    await poll();
  } catch (error) { console.error(error); }
}
function setQueuedActionsEnabled(actions, enabled) {
  for (const button of actions.querySelectorAll("button")) button.disabled = !enabled;
}
function restoreQueuedDraft(text) {
  const queuedText = String(text || "");
  const current = ui.prompt.value;
  ui.prompt.value = !current.trim() || current.trim() === queuedText.trim()
    ? queuedText
    : `${queuedText}\n\n${current}`;
  ui.prompt.focus();
  ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
  saveDraft(state.selectedId, ui.prompt.value);
  updateComposer();
}
async function mutateQueuedMessage(message, actions, method, suffix, onSuccess) {
  const id = state.selectedId;
  if (!id || !message?.id) return;
  setQueuedActionsEnabled(actions, false);
  try {
    const result = await api(
      method,
      (suffix ? API.queueSteer : API.queueItem).path({ sessionId: id, workId: message.id }),
      method === "POST" ? {} : undefined,
    );
    if (result.session) {
      mergeSession(result.session);
      if (state.selectedId === id) applySelectedSession(result.session);
    }
    onSuccess?.(result, id);
  } catch (error) {
    setQueuedActionsEnabled(actions, true);
    console.error(error);
  } finally { poll(); }
}
function steerQueuedMessage(message, actions) {
  return mutateQueuedMessage(message, actions, "POST", "/steer");
}
function cancelQueuedMessage(message, edit, actions) {
  return mutateQueuedMessage(message, actions, "DELETE", "", (result, id) => {
    if (edit && state.selectedId === id) restoreQueuedDraft(result.text ?? message.text);
  });
}

async function runCommand(command) {
  if (selectedPendingAction() || !state.selectedId || !command) return;
  const value = ui.prompt.value.trim();
  const token = value.slice(1).split(/\s/, 1)[0] ?? "";
  const args = value.slice(token.length + 1).trim();
  const id = state.selectedId;
  ui.prompt.value = "";
  saveDraft(id, "");
  const action = beginAction(id, "command");
  try {
    const result = await api(API.sessionCommand.method, API.sessionCommand.path({ sessionId: id }), { requestId: crypto.randomUUID(), name: command.name, args }, 130000);
    finishAction(action);
    if (result.session) { mergeSession(result.session); if (state.selectedId === id) applySelectedSession(result.session); }
  } catch (error) {
    finishAction(action);
    if (state.selectedId === id && !ui.prompt.value.trim()) { ui.prompt.value = value; saveDraft(id, value); }
    console.error(error);
  } finally { updateChrome(); poll(); }
}
async function sendPrompt(delivery = "followUp") {
  if (selectedPendingAction()) return;
  const command = recognizedCommandDraft();
  if (command && !state.attachments.some((file) => file.path)) { await runCommand(command); return; }
  const text = ui.prompt.value.trim();
  const attachments = state.attachments.filter((file) => file.path && !file.uploading);
  if ((!text && !attachments.length) || !state.selectedId || state.selectedState === "ABORTING") return;
  const attachmentText = attachments.length
    ? `The following files were attached to this message:\n${attachments.map((file) => `- ${file.path}`).join("\n")}`
    : "";
  const message = [text, attachmentText].filter(Boolean).join("\n\n");
  const id = state.selectedId;
  const body = { requestId: crypto.randomUUID(), text: message, delivery };
  ui.prompt.value = "";
  saveDraft(id, "");
  patchState({ attachmentGeneration: state.attachmentGeneration + 1, attachments: [] }); renderAttachments();
  const action = beginAction(id, "send");
  try {
    let accepted;
    try { accepted = await api(API.sessionPrompt.method, API.sessionPrompt.path({ sessionId: id }), body); }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); accepted = await api(API.sessionPrompt.method, API.sessionPrompt.path({ sessionId: id }), body); }
    finishAction(action);
    if (accepted.session) {
      mergeSession(accepted.session);
      if (state.selectedId === id) applySelectedSession(accepted.session);
    }
  } catch (error) {
    finishAction(action);
    if (state.selectedId === id) {
      if (!ui.prompt.value.trim()) { ui.prompt.value = text; saveDraft(id, text); }
      patchState({ attachments: [...attachments, ...state.attachments] }); renderAttachments();
    }
    console.error(error);
  } finally { updateChrome(); poll(); }
}
async function abortSelected() {
  if (!state.selectedId || !working(state.selectedState) || state.selectedState === "ABORTING" || selectedPendingAction()) return;
  const id = state.selectedId;
  const action = beginAction(id, "abort");
  try {
    const result = await api(API.sessionAbort.method, API.sessionAbort.path({ sessionId: id }), {});
    finishAction(action);
    if (result.session) {
      mergeSession(result.session);
      if (state.selectedId === id) applySelectedSession(result.session);
    }
  } catch (error) {
    finishAction(action);
    console.error(error);
  } finally { updateChrome(); poll(); }
}

function openSettings() {
  if (!state.selectedId) return;
  patchState({ settingsOpen: true }); ui.settings.hidden = false; ui.settingsScrim.hidden = false;
  requestAnimationFrame(() => ui.settings.classList.add("open")); updateChrome(); loadSettings();
}
function closeSettings() {
  patchState({ settingsOpen: false }); ui.settings.classList.remove("open"); ui.settingsScrim.hidden = true;
  setTimeout(() => { if (!state.settingsOpen) ui.settings.hidden = true; }, 180);
}
async function loadSettings() {
  const id = state.selectedId;
  ui.model.disabled = true; ui.thinking.disabled = true; ui.speed.disabled = true;
  ui.model.replaceChildren(new Option("Loading…", ""));
  ui.thinking.replaceChildren(new Option("Loading…", ""));
  ui.speed.replaceChildren(new Option("Loading…", ""));
  try {
    const { settings } = await api(API.sessionSettings.method, API.sessionSettings.path({ sessionId: id }));
    if (!state.settingsOpen || id !== state.selectedId) return;
    ui.model.replaceChildren();
    for (const [label, common] of [["Common models", true], ["Uncommon models", false]]) {
      const models = (settings.models || []).filter((model) => Boolean(model.common) === common);
      if (!models.length) continue;
      const group = document.createElement("optgroup"); group.label = label;
      for (const model of models) {
        const option = new Option(`${model.name || model.id} · ${model.provider}`, `${model.provider}\u0000${model.id}`);
        option.selected = model.provider === settings.model?.provider && model.id === settings.model?.id;
        group.append(option);
      }
      ui.model.append(group);
    }
    ui.model.disabled = ui.model.options.length === 0;
    ui.thinking.replaceChildren();
    for (const level of settings.thinkingLevels || ["off"]) {
      const option = new Option(level.toUpperCase(), level); option.selected = level === settings.thinkingLevel; ui.thinking.add(option);
    }
    ui.thinking.disabled = ui.thinking.options.length === 0;
    ui.speed.replaceChildren();
    for (const mode of settings.speedModes || []) {
      const option = new Option(mode.toUpperCase(), mode); option.selected = mode === settings.speedMode; ui.speed.add(option);
    }
    if (!ui.speed.options.length) ui.speed.add(new Option("Unavailable for this model", ""));
    ui.speed.disabled = !settings.speedModes?.length;
  } catch (error) { console.error(error); }
}
async function updateSettings(body) {
  const id = state.selectedId; if (!id) return;
  ui.model.disabled = true; ui.thinking.disabled = true; ui.speed.disabled = true;
  try { await api(API.updateSessionSettings.method, API.updateSessionSettings.path({ sessionId: id }), body); await loadSettings(); }
  catch (error) { console.error(error); loadSettings(); }
}

$("open-drawer").addEventListener("click", openDrawer);
ui.drawerScrim.addEventListener("click", closeDrawer);

ui.settingsButton.addEventListener("click", openSettings);
$("close-settings").addEventListener("click", closeSettings);
ui.settingsScrim.addEventListener("click", closeSettings);
ui.scrollback.addEventListener("scroll", () => { patchState({ followTail: nearConversationBottom() }); }, { passive: true });
ui.attach.addEventListener("click", () => ui.filePicker.click());
ui.pasteText.addEventListener("click", openPasteTextDialog);
ui.voice.addEventListener("click", toggleVoice);
ui.filePicker.addEventListener("change", () => {
  uploadFiles([...ui.filePicker.files]);
  ui.filePicker.value = "";
});
ui.pasteTextContent.addEventListener("input", () => {
  ui.uploadPastedText.disabled = ui.pasteTextContent.value.trim().length === 0;
});
$("cancel-paste-text").addEventListener("click", () => ui.pasteTextDialog.close());
ui.pasteTextForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = ui.pasteTextContent.value;
  if (!text.trim()) return;
  const file = new File([text], pastedTextFileName(ui.pasteTextName.value), { type: "text/plain;charset=utf-8" });
  ui.pasteTextDialog.close();
  uploadFiles([file]);
});
ui.threadsTab.addEventListener("click", () => selectDrawerTab("threads"));
ui.agentsTab.addEventListener("click", () => selectDrawerTab("agents"));
ui.archivedTab.addEventListener("click", () => selectDrawerTab("archived"));
ui.thunderControl.addEventListener("click", toggleThunder);
ui.openaiGovernorControl.addEventListener("click", () => toggleGovernor("openai"));
ui.anthropicGovernorControl.addEventListener("click", () => toggleGovernor("anthropic"));
ui.prompt.addEventListener("input", () => { saveDraft(state.selectedId, ui.prompt.value); updateComposer(); });
// On a soft keyboard Enter is the newline key and the send button is the only way to send,
// so the composer must not steal it. A hardware keyboard keeps Enter as send.
const softKeyboard = matchMedia("(hover: none) and (pointer: coarse)");
function applyEnterKeyHint() {
  ui.prompt.enterKeyHint = softKeyboard.matches ? "enter" : "send";
}
applyEnterKeyHint();
softKeyboard.addEventListener("change", applyEnterKeyHint);
ui.prompt.addEventListener("keydown", (event) => {
  if (softKeyboard.matches) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (ui.prompt.value.trim() || state.attachments.some((file) => file.path)) sendPrompt("followUp");
  }
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (ui.prompt.value.trim() || state.attachments.some((file) => file.path)) sendPrompt("followUp");
  else if (working(state.selectedState)) abortSelected();
});
ui.model.addEventListener("change", () => {
  const [modelProvider, modelId] = ui.model.value.split("\u0000");
  if (modelProvider && modelId) updateSettings({ modelProvider, modelId });
});
ui.thinking.addEventListener("change", () => updateSettings({ thinkingLevel: ui.thinking.value }));
ui.speed.addEventListener("change", () => updateSettings({ speedMode: ui.speed.value }));
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || ui.pasteTextDialog.open || ui.unlockDialog.open) return;
  if (threadStartMenu?.expanded) threadStartMenu.collapse();
  else if (state.settingsOpen) closeSettings();
  else closeDrawer();
});
window.addEventListener("resize", () => {
  threadStartMenu?.collapse();
  if (innerWidth >= 1000) { ui.drawer.classList.add("open"); ui.drawerScrim.hidden = true; }
});

window.addEventListener("pagehide", stopVoice);
if (innerWidth >= 1000) ui.drawer.classList.add("open");
restoreDrawerTab();
renderVoiceState("idle"); updateChrome(); renderTabs(); renderAgentList(); refreshMachineControls(); loadThreadStarts(); poll();
