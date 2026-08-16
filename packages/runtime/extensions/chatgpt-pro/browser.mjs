import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi", "agent");
const POOL_PATH = join(AGENT_DIR, "chatgpt-pro-pool.json");
const POOL_LOCK = join(AGENT_DIR, ".chatgpt-pro-pool.lock");
const PROVIDER_AUDIT_DIR = join(HOME, "data", "agent-orchestrator", "pro", "provider-audit");
export const PRO_PROFILE_CONFIG_PATH = join(AGENT_DIR, "chatgpt-pro-profiles.json");
export const PRO_MAX_PARALLEL = 4;
const DEFAULT_PROFILE_NAME = "limmy-google";
const MODEL_ID = "gpt-5-6-pro";
export const PRO_TRANSPORT_HORIZONS = Object.freeze({
  responseWaitMs: 2 * 60 * 60_000 + 45 * 60_000,
  stalledWorkMs: 45 * 60_000,
  browserTimeoutSeconds: 3 * 60 * 60,
  accountLeaseMs: 3 * 60 * 60_000,
});
const ACCOUNT_LEASE_MS = PRO_TRANSPORT_HORIZONS.accountLeaseMs;
const FALLBACK_COOLDOWN_BASE_MS = 15 * 60_000;
const FALLBACK_COOLDOWN_MAX_MS = 4 * 60 * 60_000;
const FALLBACK_STREAK_RESET_MS = 24 * 60 * 60_000;
const OPERATIONAL_COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const MAX_WAIT_MS = PRO_TRANSPORT_HORIZONS.responseWaitMs;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request was aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    }, { once: true });
  });
}

async function withDirectoryLock(path, signal, fn) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { recursive: true, force: true });
      } catch {}
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await sleep(25 + Math.floor(Math.random() * 50), signal);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function configuredProfileNames() {
  let names = [DEFAULT_PROFILE_NAME];
  try {
    const raw = JSON.parse(readFileSync(PRO_PROFILE_CONFIG_PATH, "utf8"));
    if (raw?.version !== 1 || !Array.isArray(raw.profiles)) throw new Error("expected version 1 with a profiles array");
    names = raw.profiles;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Invalid ChatGPT Pro profile config: ${error.message}`);
  }
  if (names.length < 1 || names.length > PRO_MAX_PARALLEL ||
      names.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) ||
      new Set(names).size !== names.length) {
    throw new Error(`ChatGPT Pro profile config must contain 1-${PRO_MAX_PARALLEL} unique Kernel profile names`);
  }
  return names;
}

function defaultProfileState(browserProfile) {
  return {
    browserProfile,
    selectionCount: 0,
    inFlightUntil: 0,
    cooldownUntil: 0,
    cooldownReason: null,
    fallbackStreak: 0,
    lastFallbackAt: null,
    lastVerifiedAt: null,
  };
}

export function defaultPoolState(profileNames = configuredProfileNames()) {
  return {
    version: 4,
    maxParallel: PRO_MAX_PARALLEL,
    profiles: profileNames.map(defaultProfileState),
  };
}

function normalizeProfile(raw, browserProfile) {
  return {
    ...defaultProfileState(browserProfile),
    selectionCount: Number.isInteger(raw?.selectionCount) ? raw.selectionCount : 0,
    inFlightUntil: Number(raw?.inFlightUntil) || 0,
    cooldownUntil: Number(raw?.cooldownUntil) || 0,
    cooldownReason: typeof raw?.cooldownReason === "string" ? raw.cooldownReason : null,
    fallbackStreak: Number.isInteger(raw?.fallbackStreak) && raw.fallbackStreak >= 0 ? raw.fallbackStreak : 0,
    lastFallbackAt: typeof raw?.lastFallbackAt === "string" ? raw.lastFallbackAt : null,
    lastVerifiedAt: typeof raw?.lastVerifiedAt === "string" ? raw.lastVerifiedAt : null,
  };
}

export function normalizePoolState(raw, profileNames = configuredProfileNames()) {
  const existing = raw?.version === 4 && Array.isArray(raw.profiles)
    ? raw.profiles
    : raw?.version === 3 && typeof raw.browserProfile === "string"
      ? [raw]
      : [];
  return {
    ...defaultPoolState(profileNames),
    profiles: profileNames.map((browserProfile) =>
      normalizeProfile(existing.find((profile) => profile?.browserProfile === browserProfile), browserProfile)),
  };
}

function readPoolState() {
  try {
    return normalizePoolState(JSON.parse(readFileSync(POOL_PATH, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === "ENOENT") return defaultPoolState();
    throw error;
  }
}

export function browserPoolCapacitySnapshot(raw, at = Date.now(), profileNames = configuredProfileNames()) {
  const state = normalizePoolState(raw, profileNames);
  const inFlight = state.profiles.filter((profile) => profile.inFlightUntil > at).length;
  const eligible = state.profiles.filter((profile) => profile.cooldownUntil <= at).length;
  const available = state.profiles.filter((profile) => profile.cooldownUntil <= at && profile.inFlightUntil <= at).length;
  return { configured: state.profiles.length, eligible, inFlight, available, maxParallel: PRO_MAX_PARALLEL };
}

export function nextFallbackCooldown(state, now = Date.now()) {
  const lastFallbackMs = Date.parse(state.lastFallbackAt ?? "");
  const streak = Number.isFinite(lastFallbackMs) && now - lastFallbackMs < FALLBACK_STREAK_RESET_MS
    ? state.fallbackStreak + 1
    : 1;
  return {
    streak,
    cooldownMs: Math.min(FALLBACK_COOLDOWN_BASE_MS * (2 ** Math.max(0, streak - 1)), FALLBACK_COOLDOWN_MAX_MS),
  };
}

async function acquireProfile(signal) {
  return withDirectoryLock(POOL_LOCK, signal, () => {
    const state = readPoolState();
    const at = Date.now();
    const selected = state.profiles
      .filter((profile) => profile.cooldownUntil <= at && profile.inFlightUntil <= at)
      .sort((left, right) => left.selectionCount - right.selectionCount || left.browserProfile.localeCompare(right.browserProfile))[0];
    if (!selected) {
      const snapshot = browserPoolCapacitySnapshot(state, at, state.profiles.map((profile) => profile.browserProfile));
      const nextCooldown = state.profiles
        .map((profile) => profile.cooldownUntil)
        .filter((until) => until > at)
        .sort((left, right) => left - right)[0];
      const next = nextCooldown ? `; next cooldown ends ${new Date(nextCooldown).toISOString()}` : "";
      throw new Error(`No ChatGPT Pro entitlement is available (active ${snapshot.inFlight}/${PRO_MAX_PARALLEL}, configured ${snapshot.configured}${next})`);
    }
    selected.selectionCount += 1;
    selected.inFlightUntil = at + ACCOUNT_LEASE_MS;
    writeJsonAtomic(POOL_PATH, state);
    return selected.browserProfile;
  });
}

async function finishProfile(browserProfile, { verified = false, cooldownMs = 0, reason = null } = {}, signal) {
  await withDirectoryLock(POOL_LOCK, signal, () => {
    const state = readPoolState();
    const selected = state.profiles.find((profile) => profile.browserProfile === browserProfile);
    if (!selected) throw new Error(`ChatGPT Pro profile left configured custody while in flight: ${browserProfile}`);
    selected.inFlightUntil = 0;
    if (verified) {
      selected.cooldownUntil = 0;
      selected.cooldownReason = null;
      selected.fallbackStreak = 0;
      selected.lastFallbackAt = null;
      selected.lastVerifiedAt = new Date().toISOString();
    } else if (cooldownMs > 0) {
      let effectiveCooldownMs = cooldownMs;
      if (reason === "pro-fallback") {
        const fallback = nextFallbackCooldown(selected);
        selected.fallbackStreak = fallback.streak;
        selected.lastFallbackAt = new Date().toISOString();
        effectiveCooldownMs = fallback.cooldownMs;
      }
      selected.cooldownUntil = Date.now() + effectiveCooldownMs;
      selected.cooldownReason = reason ?? "provider failure";
    }
    writeJsonAtomic(POOL_PATH, state);
  });
}

async function kernel(args, { signal, timeout = 60_000 } = {}) {
  const result = await execFileAsync("kernel", args, {
    signal,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}

async function createBrowser(browserProfile, signal) {
  const stdout = await kernel([
    "browsers", "create",
    "--profile-name", browserProfile,
    "--save-changes",
    "--start-url", "https://chatgpt.com/",
    "--timeout", String(PRO_TRANSPORT_HORIZONS.browserTimeoutSeconds),
    "--viewport", "1440x900@25",
    "--telemetry=console,network,page,interaction",
    "--output", "json",
  ], { signal, timeout: 90_000 });
  const browser = JSON.parse(stdout);
  if (!browser?.session_id || !browser?.cdp_ws_url) throw new Error("Kernel browser creation returned incomplete connection data");
  return { sessionId: browser.session_id, cdpUrl: browser.cdp_ws_url };
}

async function deleteBrowser(sessionId) {
  if (!sessionId) return;
  try {
    await kernel(["browsers", "delete", sessionId], { timeout: 60_000 });
  } catch {}
}

function completedProWork(evidence) {
  if (evidence.pro_progress === 100 && evidence.pro_skipped === false) return true;
  const turnId = evidence.leaf_working_turn_id;
  return evidence.pro_work_model_slug === MODEL_ID &&
    evidence.pro_work_status === "finished_successfully" &&
    evidence.pro_skipped === false &&
    Number.isFinite(evidence.pro_finished_duration_sec) &&
    evidence.pro_finished_duration_sec > 0 &&
    evidence.reasoning_status === "reasoning_ended" &&
    Number.isFinite(evidence.reasoning_start_time) &&
    Number.isFinite(evidence.reasoning_end_time) &&
    evidence.reasoning_end_time >= evidence.reasoning_start_time &&
    typeof turnId === "string" && turnId.length > 0 &&
    evidence.pro_working_turn_id === turnId &&
    evidence.reasoning_working_turn_id === turnId;
}

export function conversationModelEvidence(data) {
  const mapping = data?.mapping && typeof data.mapping === "object" ? data.mapping : {};
  const current = data?.current_node;
  const leaf = current && mapping[current]?.message ? mapping[current].message : null;
  const metadata = leaf?.metadata || {};
  const evidence = {};
  for (const key of ["model_slug", "default_model_slug", "finish_details", "is_complete"]) {
    if (metadata[key] !== undefined && metadata[key] !== null) evidence[key] = metadata[key];
  }
  if (leaf) {
    evidence.message_status = leaf.status;
    evidence.message_end_turn = leaf.end_turn;
    evidence.current_node_is_leaf = Array.isArray(mapping[current]?.children) && mapping[current].children.length === 0;
    if (typeof metadata.working_turn_id === "string") evidence.leaf_working_turn_id = metadata.working_turn_id;
  }
  evidence.conversation_async_status = data && Object.hasOwn(data, "async_status") ? data.async_status : undefined;
  for (const node of Object.values(mapping)) {
    const message = node?.message;
    if (!message || typeof message !== "object") continue;
    const md = message.metadata || {};
    if (message.author?.role === "user" && md.resolved_model_slug) evidence.resolved_model_slug = md.resolved_model_slug;
    if (md.pro_progress !== undefined) evidence.pro_progress = md.pro_progress;
    if (md.pro_skipped !== undefined) evidence.pro_skipped = md.pro_skipped;
    if (md.pro_progress !== undefined || md.pro_skipped !== undefined) {
      evidence.pro_finished_duration_sec = md.finished_duration_sec;
      evidence.pro_finished_text = md.finished_text;
      evidence.finished_duration_sec = md.finished_duration_sec;
      evidence.finished_text = md.finished_text;
      evidence.pro_work_model_slug = md.model_slug;
      evidence.pro_work_status = message.status;
      evidence.pro_working_turn_id = md.working_turn_id;
    }
    if (message.author?.role === "assistant" && md.reasoning_status !== undefined) {
      evidence.reasoning_status = md.reasoning_status;
      evidence.reasoning_start_time = md.reasoning_start_time;
      evidence.reasoning_end_time = md.reasoning_end_time;
      evidence.reasoning_working_turn_id = md.working_turn_id;
    }
  }
  const completionVerified = evidence.is_complete === true ||
    (evidence.is_complete === undefined && evidence.current_node_is_leaf === true);
  evidence.pro_execution_verified =
    evidence.resolved_model_slug === MODEL_ID &&
    evidence.model_slug === MODEL_ID &&
    completedProWork(evidence) &&
    evidence.message_status === "finished_successfully" &&
    evidence.message_end_turn === true &&
    completionVerified;
  return evidence;
}

export function conversationLeafText(data) {
  const mapping = data?.mapping && typeof data.mapping === "object" ? data.mapping : {};
  const leaf = data?.current_node && mapping[data.current_node]?.message;
  const parts = leaf?.content?.parts;
  return Array.isArray(parts) ? parts.filter((part) => typeof part === "string").join("\n") : "";
}

export function conversationStreamEvidence(body) {
  const evidence = {};
  let text = "";
  const inspectMessage = (message) => {
    if (!message || typeof message !== "object") return;
    const role = message.author?.role;
    const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
    if (role === "user" && typeof metadata.resolved_model_slug === "string") {
      evidence.resolved_model_slug = metadata.resolved_model_slug;
    }
    if (metadata.pro_progress !== undefined) evidence.pro_progress = metadata.pro_progress;
    if (metadata.pro_skipped !== undefined) evidence.pro_skipped = metadata.pro_skipped;
    if (metadata.pro_progress !== undefined || metadata.pro_skipped !== undefined) {
      evidence.pro_finished_duration_sec = metadata.finished_duration_sec;
      evidence.pro_finished_text = metadata.finished_text;
      evidence.finished_duration_sec = metadata.finished_duration_sec;
      evidence.finished_text = metadata.finished_text;
      evidence.pro_work_model_slug = metadata.model_slug;
      evidence.pro_work_status = message.status;
      evidence.pro_working_turn_id = metadata.working_turn_id;
    }
    if (role === "assistant") {
      for (const key of ["model_slug", "default_model_slug", "finish_details", "is_complete"]) {
        if (metadata[key] !== undefined && metadata[key] !== null) evidence[key] = metadata[key];
      }
      if (metadata.reasoning_status !== undefined) {
        evidence.reasoning_status = metadata.reasoning_status;
        evidence.reasoning_start_time = metadata.reasoning_start_time;
        evidence.reasoning_end_time = metadata.reasoning_end_time;
        evidence.reasoning_working_turn_id = metadata.working_turn_id;
      }
      if (metadata.model_slug === MODEL_ID && typeof metadata.working_turn_id === "string") {
        evidence.leaf_working_turn_id = metadata.working_turn_id;
      }
      if (message.status !== undefined) evidence.message_status = message.status;
      if (message.end_turn !== undefined) evidence.message_end_turn = message.end_turn;
      const parts = message.content?.parts;
      if (Array.isArray(parts)) {
        const candidate = parts.filter((part) => typeof part === "string").join("\n");
        if (candidate) text = candidate;
      }
    }
  };
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (value.author?.role) inspectMessage(value);
    if (value.message?.author?.role) inspectMessage(value.message);
    for (const [key, child] of Object.entries(value)) {
      if (key === "message" && child?.author?.role) continue;
      if (Array.isArray(child)) child.forEach((item) => walk(item, depth + 1));
      else if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    const payload = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!payload || payload === "[DONE]") continue;
    try { walk(JSON.parse(payload)); } catch {}
  }
  evidence.pro_execution_verified =
    evidence.resolved_model_slug === MODEL_ID &&
    evidence.model_slug === MODEL_ID &&
    completedProWork(evidence) &&
    evidence.message_status === "finished_successfully" &&
    evidence.message_end_turn === true &&
    evidence.is_complete === true;
  return { evidence, text };
}

function conversationIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/c\/([^/]+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function checkAuthentication(page) {
  const auth = await page.evaluate(async () => {
    try {
      const response = await fetch("/api/auth/session", { credentials: "include" });
      const body = await response.json().catch(() => null);
      return { status: response.status, hasUser: Boolean(body?.user), hasAccessToken: Boolean(body?.accessToken) };
    } catch (error) {
      return { status: 0, hasUser: false, hasAccessToken: false, error: String(error) };
    }
  });
  if (!auth.hasUser || !auth.hasAccessToken) {
    throw new Error("Kernel profile is not authenticated to ChatGPT; reauthenticate the chatgpt.com managed-auth connection");
  }
}

async function ensureProSelection(page) {
  const composer = page.locator("#prompt-textarea");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  const picker = page.getByRole("button", { name: /^(Instant|Medium|High|Extra High|Pro)$/ }).last();
  await picker.waitFor({ state: "visible", timeout: 15_000 });
  await picker.click();
  const content = page.locator('[data-testid="composer-intelligence-picker-content"]');
  await content.waitFor({ state: "visible", timeout: 10_000 });
  const power = page.getByRole("menuitem", { name: "Power" });
  await power.waitFor({ state: "visible", timeout: 10_000 });
  const slider = power.locator('[role="slider"]');
  let value = Number(await slider.getAttribute("aria-valuenow"));
  const max = Number(await slider.getAttribute("aria-valuemax"));
  if (!Number.isInteger(value) || !Number.isInteger(max) || max < 1) {
    throw new Error("ChatGPT power slider did not expose a verifiable value range");
  }
  await power.focus();
  while (value < max) {
    await power.press("ArrowRight");
    await page.waitForTimeout(200);
    const next = Number(await slider.getAttribute("aria-valuenow"));
    if (!Number.isInteger(next) || next <= value) throw new Error("ChatGPT power slider did not advance toward Pro");
    value = next;
  }
  await page.waitForTimeout(500);
  const pickerText = (await content.innerText()).replace(/\s+/g, " ").trim();
  if (!/Pro,\s*5 of 5/i.test(pickerText) || !/GPT-5\.6 Sol/i.test(pickerText) || !/Effort\s+Pro/i.test(pickerText)) {
    throw new Error(`ChatGPT picker did not verify GPT-5.6 Sol Pro: ${pickerText.slice(0, 500)}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const selected = (await page.getByRole("button", { name: /^(Instant|Medium|High|Extra High|Pro)$/ }).last().innerText()).trim();
  if (selected !== "Pro") throw new Error(`ChatGPT picker closed on ${JSON.stringify(selected)}, not Pro`);
  return { selected, pickerText };
}

async function submitPrompt(page, prompt) {
  const observed = { requestedModel: null };
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const onRequest = (request) => {
    try {
      if (request.method() !== "POST" || !/\/conversation(?:$|\?)/.test(request.url())) return;
      const body = request.postDataJSON();
      if (typeof body?.model === "string") observed.requestedModel = body.model;
    } catch {}
  };
  const onResponse = (response) => {
    try {
      const request = response.request();
      if (request.method() === "POST" && /\/conversation(?:$|\?)/.test(response.url())) resolveResponse(response);
    } catch {}
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  const remove = () => {
    page.off("request", onRequest);
    page.off("response", onResponse);
  };
  try {
    const composer = page.locator("#prompt-textarea");
    await composer.fill(prompt);
    const send = page.locator('[data-testid="send-button"], button[aria-label*="Send" i]').first();
    await send.waitFor({ state: "visible", timeout: 15_000 });
    if (!(await send.isEnabled())) throw new Error("ChatGPT send button remained disabled after prompt insertion");
    await send.click();
    await page.waitForURL((url) => conversationIdFromUrl(url.toString()) !== null, { timeout: 120_000 });
    return { conversationId: conversationIdFromUrl(page.url()), observed, responsePromise, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

async function readPersistedConversation(page, conversationId) {
  return page.evaluate(async ({ conversationId }) => {
    const sessionResponse = await fetch("/api/auth/session", { credentials: "include" });
    const session = await sessionResponse.json().catch(() => null);
    if (!session?.accessToken) return { status: 401, data: null };
    const response = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}?include_visually_hidden_messages=true&include_widget_state=true`, {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "chatgpt-account-id": session.account?.id || "",
      },
    });
    return { status: response.status, data: response.ok ? await response.json() : null };
  }, { conversationId });
}

async function visibleProviderWarning(page) {
  try {
    return await page.locator('[role="alert"]:visible, [data-testid*="rate-limit"]:visible').evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText || "").trim()).filter(Boolean).join(" | ").slice(0, 1000));
  } catch {
    return "";
  }
}

async function withDeadline(promise, maxWaitMs, signal) {
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for ChatGPT Pro response stream")), maxWaitMs);
    timer.unref?.();
  });
  const aborted = new Promise((_, reject) => {
    if (signal?.aborted) return reject(new Error("Request was aborted"));
    signal?.addEventListener("abort", () => reject(new Error("Request was aborted")), { once: true });
  });
  return Promise.race([promise, timeout, aborted]);
}

export function isTerminalConversationEvidence(evidence) {
  if (evidence.pro_execution_verified === true) return true;
  const messageFinished = evidence.message_status === "finished_successfully" &&
    evidence.message_end_turn === true && evidence.current_node_is_leaf === true;
  const routedModel = evidence.resolved_model_slug ?? evidence.model_slug;
  return messageFinished && (
    (typeof routedModel === "string" && routedModel !== MODEL_ID) ||
    evidence.pro_skipped === true
  );
}

export function conversationActivityMarker(data, evidence = conversationModelEvidence(data)) {
  let latestMessageTime = 0;
  let messageCount = 0;
  for (const node of Object.values(data?.mapping ?? {})) {
    const message = node?.message;
    if (!message) continue;
    messageCount += 1;
    latestMessageTime = Math.max(latestMessageTime, Number(message.update_time) || 0, Number(message.create_time) || 0);
  }
  return JSON.stringify([
    data?.current_node ?? null,
    messageCount,
    latestMessageTime,
    evidence.pro_progress ?? null,
    evidence.pro_work_status ?? null,
    evidence.reasoning_status ?? null,
  ]);
}

async function stopActiveResponse(page) {
  const stop = page.locator('[data-testid="stop-button"], button[aria-label*="Stop" i]').first();
  if (!await stop.isVisible().catch(() => false)) return false;
  await stop.click();
  return true;
}

async function waitForStreamEvidence(page, submitted, signal, maxWaitMs = MAX_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const response = await withDeadline(submitted.responsePromise, Math.min(remaining(), 120_000), signal);
  let persisted = null;
  let activityMarker = null;
  let lastActivityAt = Date.now();
  let stalled = false;
  let stopRequested = false;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    // A Pro POST stream can finish while the server-side reasoning turn remains
    // async. The persisted conversation, not stream closure or early DOM text,
    // decides when the turn has actually ended.
    const durableConversationId = conversationIdFromUrl(page.url()) ?? submitted.conversationId;
    const result = await readPersistedConversation(page, durableConversationId);
    if (result.data) {
      persisted = result.data;
      const candidate = conversationModelEvidence(result.data);
      if (isTerminalConversationEvidence(candidate)) break;
      const marker = conversationActivityMarker(result.data, candidate);
      if (marker !== activityMarker) {
        activityMarker = marker;
        lastActivityAt = Date.now();
      } else if (Date.now() - lastActivityAt >= PRO_TRANSPORT_HORIZONS.stalledWorkMs) {
        stopRequested = await stopActiveResponse(page);
        stalled = true;
        break;
      }
    }
    await sleep(Math.min(5_000, remaining()), signal);
  }
  if (!persisted) throw new Error("ChatGPT conversation could not be read back with the signed browser session");

  let body = "";
  let streamError = null;
  try {
    await withDeadline(response.finished(), Math.min(remaining(), stalled ? 60_000 : remaining()), signal);
    body = (await response.body()).toString("utf8");
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
  }
  const streamed = conversationStreamEvidence(body);
  const assistant = page.locator('[data-message-author-role="assistant"]').last();
  const assistantVisible = await assistant.isVisible().catch(() => false);
  const domText = assistantVisible
    ? (await assistant.locator(".markdown").count()
      ? await assistant.locator(".markdown").last().innerText()
      : await assistant.innerText())
    : "";
  const domModel = assistantVisible ? await assistant.getAttribute("data-message-model-slug") : null;
  const proFeedback = await page.getByRole("button", { name: /Pro feedback/i }).count();
  const authoritative = conversationModelEvidence(persisted);
  const persistedText = conversationLeafText(persisted);
  return {
    text: persistedText.trim() || domText.trim() || streamed.text,
    evidence: {
      ...authoritative,
      stream_resolved_model_slug: streamed.evidence.resolved_model_slug,
      stream_model_slug: streamed.evidence.model_slug,
      stream_pro_progress: streamed.evidence.pro_progress,
      stream_pro_skipped: streamed.evidence.pro_skipped,
      dom_model_slug: domModel,
      pro_feedback_control: proFeedback > 0,
      response_stream_bytes: Buffer.byteLength(body),
      transport_stalled: stalled,
      transport_stop_requested: stopRequested,
      response_stream_error: streamError,
    },
  };
}

function recordProviderAudit(value, responseText) {
  mkdirSync(PROVIDER_AUDIT_DIR, { recursive: true, mode: 0o700 });
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const responsePath = join(PROVIDER_AUDIT_DIR, `${stem}.response.md`);
  const auditPath = join(PROVIDER_AUDIT_DIR, `${stem}.json`);
  writeFileSync(responsePath, responseText, { mode: 0o600 });
  writeJsonAtomic(auditPath, { ...value, response_path: responsePath });
  return { auditPath, responsePath };
}

function verificationFailure(evidence) {
  return `Pro browser execution failed verification: resolved=${String(evidence.resolved_model_slug)} executed=${String(evidence.model_slug)} progress=${String(evidence.pro_progress)} skipped=${String(evidence.pro_skipped)} work=${String(evidence.pro_work_status)} reasoning=${String(evidence.reasoning_status)}`;
}

function failureCooldown(error, evidence, warning) {
  const message = `${error instanceof Error ? error.message : String(error)} ${warning}`;
  if (evidence?.transport_stalled === true) {
    return { cooldownMs: FALLBACK_COOLDOWN_MAX_MS, reason: "pro-stalled" };
  }
  if (evidence?.resolved_model_slug && evidence.resolved_model_slug !== MODEL_ID) {
    return { cooldownMs: FALLBACK_COOLDOWN_BASE_MS, reason: "pro-fallback" };
  }
  if (/rate.?limit|usage limit|quota|too many requests|temporarily unavailable/i.test(message)) {
    return { cooldownMs: RATE_LIMIT_COOLDOWN_MS, reason: "rate-limit" };
  }
  return { cooldownMs: OPERATIONAL_COOLDOWN_MS, reason: "browser-operation" };
}

export async function completeInKernelBrowser(prompt, { signal, maxWaitMs = MAX_WAIT_MS, onStatus, auditContext = null } = {}) {
  const browserProfile = await acquireProfile(signal);
  try {
    const state = readPoolState();
    onStatus?.({
      phase: "running",
      browserProfile,
      capacity: browserPoolCapacitySnapshot(state, Date.now(), state.profiles.map((profile) => profile.browserProfile)),
    });
  } catch {}
  let kernelBrowser = null;
  let playwrightBrowser = null;
  let page = null;
  let evidence = {};
  let responseText = "";
  let warning = "";
  let audit = null;
  const started = Date.now();
  try {
    kernelBrowser = await createBrowser(browserProfile, signal);
    playwrightBrowser = await chromium.connectOverCDP(kernelBrowser.cdpUrl, { timeout: 60_000 });
    const context = playwrightBrowser.contexts()[0];
    if (!context) throw new Error("Kernel CDP endpoint exposed no browser context");
    page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await checkAuthentication(page);
    const selection = await ensureProSelection(page);
    const submitted = await submitPrompt(page, prompt);
    try {
      const verified = await waitForStreamEvidence(page, submitted, signal, maxWaitMs);
      responseText = verified.text;
      evidence = {
        ...verified.evidence,
        outgoing_model: submitted.observed.requestedModel,
        picker_selected: selection.selected,
        picker_model: "GPT-5.6 Sol",
        picker_effort: "Pro",
        browser_profile: browserProfile,
      };
    } finally {
      submitted.remove();
    }
    warning = await visibleProviderWarning(page);
    audit = recordProviderAudit({
      at: new Date().toISOString(),
      transport: "kernel-browser-playwright",
      browser_profile: browserProfile,
      conversation_id: conversationIdFromUrl(page.url()),
      requested_model: MODEL_ID,
      caller: auditContext,
      elapsed_sec: (Date.now() - started) / 1000,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      response_chars: responseText.length,
      evidence,
      provider_warning: warning || null,
    }, responseText);
    if (evidence.pro_execution_verified !== true) throw new Error(verificationFailure(evidence));
    await finishProfile(browserProfile, { verified: true }, signal);
    return { text: responseText, evidence, audit, browserProfile };
  } catch (error) {
    warning ||= page ? await visibleProviderWarning(page) : "";
    if (!responseText || Object.keys(evidence).length === 0) {
      recordProviderAudit({
        at: new Date().toISOString(),
        transport: "kernel-browser-playwright",
        browser_profile: browserProfile,
        requested_model: MODEL_ID,
        caller: auditContext,
        elapsed_sec: (Date.now() - started) / 1000,
        prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
        response_chars: responseText.length,
        evidence,
        provider_warning: warning || null,
        error: error instanceof Error ? error.message : String(error),
      }, responseText);
    }
    const cooldown = failureCooldown(error, evidence, warning);
    try { await finishProfile(browserProfile, cooldown, signal?.aborted ? undefined : signal); } catch {}
    throw error;
  } finally {
    // Kernel owns browser termination and profile persistence. Deleting the
    // session also drops the CDP connection; Playwright must not send
    // Browser.close first because that can bypass Kernel's save lifecycle.
    await deleteBrowser(kernelBrowser?.sessionId);
  }
}
