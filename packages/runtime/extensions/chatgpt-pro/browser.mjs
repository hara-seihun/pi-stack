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
const PROFILE_NAME = process.env.CHATGPT_PRO_BROWSER_PROFILE || "limmy-google";
const MODEL_ID = "gpt-5-6-pro";
const ACCOUNT_LEASE_MS = 45 * 60_000;
const FALLBACK_COOLDOWN_MS = 5 * 60_000;
const OPERATIONAL_COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const MAX_WAIT_MS = 35 * 60_000;

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

export function defaultPoolState() {
  return {
    version: 3,
    browserProfile: PROFILE_NAME,
    selectionCount: 0,
    inFlightUntil: 0,
    cooldownUntil: 0,
    cooldownReason: null,
    lastVerifiedAt: null,
  };
}

export function normalizePoolState(raw) {
  if (raw?.version !== 3 || raw?.browserProfile !== PROFILE_NAME) return defaultPoolState();
  return {
    ...defaultPoolState(),
    selectionCount: Number.isInteger(raw.selectionCount) ? raw.selectionCount : 0,
    inFlightUntil: Number(raw.inFlightUntil) || 0,
    cooldownUntil: Number(raw.cooldownUntil) || 0,
    cooldownReason: typeof raw.cooldownReason === "string" ? raw.cooldownReason : null,
    lastVerifiedAt: typeof raw.lastVerifiedAt === "string" ? raw.lastVerifiedAt : null,
  };
}

function readPoolState() {
  try {
    return normalizePoolState(JSON.parse(readFileSync(POOL_PATH, "utf8")));
  } catch {
    return defaultPoolState();
  }
}

async function acquireProfile(signal) {
  await withDirectoryLock(POOL_LOCK, signal, () => {
    const state = readPoolState();
    const now = Date.now();
    if (state.cooldownUntil > now) {
      throw new Error(`ChatGPT Pro browser profile is cooling until ${new Date(state.cooldownUntil).toISOString()}: ${state.cooldownReason ?? "provider failure"}`);
    }
    if (state.inFlightUntil > now) {
      throw new Error(`ChatGPT Pro browser profile is already in flight until ${new Date(state.inFlightUntil).toISOString()}`);
    }
    state.selectionCount += 1;
    state.inFlightUntil = now + ACCOUNT_LEASE_MS;
    writeJsonAtomic(POOL_PATH, state);
  });
}

async function finishProfile({ verified = false, cooldownMs = 0, reason = null } = {}, signal) {
  await withDirectoryLock(POOL_LOCK, signal, () => {
    const state = readPoolState();
    state.inFlightUntil = 0;
    if (verified) {
      state.cooldownUntil = 0;
      state.cooldownReason = null;
      state.lastVerifiedAt = new Date().toISOString();
    } else if (cooldownMs > 0) {
      state.cooldownUntil = Date.now() + cooldownMs;
      state.cooldownReason = reason ?? "provider failure";
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

async function createBrowser(signal) {
  const stdout = await kernel([
    "browsers", "create",
    "--profile-name", PROFILE_NAME,
    "--save-changes",
    "--start-url", "https://chatgpt.com/",
    "--timeout", "2400",
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
  }
  evidence.conversation_async_status = data && Object.hasOwn(data, "async_status") ? data.async_status : undefined;
  for (const node of Object.values(mapping)) {
    const message = node?.message;
    if (!message || typeof message !== "object") continue;
    const md = message.metadata || {};
    if (message.author?.role === "user" && md.resolved_model_slug) evidence.resolved_model_slug = md.resolved_model_slug;
    if (md.pro_progress !== undefined) {
      evidence.pro_progress = md.pro_progress;
      evidence.pro_skipped = md.pro_skipped;
      evidence.finished_duration_sec = md.finished_duration_sec;
      evidence.finished_text = md.finished_text;
    }
  }
  const completionVerified = evidence.is_complete === true ||
    (evidence.is_complete === undefined && evidence.current_node_is_leaf === true);
  evidence.pro_execution_verified =
    evidence.resolved_model_slug === MODEL_ID &&
    evidence.model_slug === MODEL_ID &&
    evidence.pro_progress === 100 &&
    evidence.pro_skipped === false &&
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
    if (metadata.pro_progress !== undefined) {
      evidence.pro_progress = metadata.pro_progress;
      evidence.pro_skipped = metadata.pro_skipped;
      evidence.finished_duration_sec = metadata.finished_duration_sec;
      evidence.finished_text = metadata.finished_text;
    }
    if (role === "assistant") {
      for (const key of ["model_slug", "default_model_slug", "finish_details", "is_complete"]) {
        if (metadata[key] !== undefined && metadata[key] !== null) evidence[key] = metadata[key];
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
    evidence.pro_progress === 100 &&
    evidence.pro_skipped === false &&
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

async function waitForStreamEvidence(page, submitted, signal, maxWaitMs = MAX_WAIT_MS) {
  const response = await withDeadline(submitted.responsePromise, Math.min(maxWaitMs, 120_000), signal);
  await withDeadline(response.finished(), maxWaitMs, signal);
  const body = (await response.body()).toString("utf8");
  const streamed = conversationStreamEvidence(body);
  const assistant = page.locator('[data-message-author-role="assistant"]').last();
  await assistant.waitFor({ state: "visible", timeout: 30_000 });
  const domText = (await assistant.locator(".markdown").count())
    ? await assistant.locator(".markdown").last().innerText()
    : await assistant.innerText();
  const domModel = await assistant.getAttribute("data-message-model-slug");
  const proFeedback = await page.getByRole("button", { name: /Pro feedback/i }).count();

  let persisted = null;
  const persistedDeadline = Date.now() + Math.min(120_000, maxWaitMs);
  while (Date.now() < persistedDeadline) {
    signal?.throwIfAborted();
    // ChatGPT may first route the tab through a transient WEB:* id and replace
    // it with the durable conversation id only after the Pro stream finishes.
    const durableConversationId = conversationIdFromUrl(page.url()) ?? submitted.conversationId;
    const result = await readPersistedConversation(page, durableConversationId);
    if (result.data) {
      persisted = result.data;
      const candidate = conversationModelEvidence(result.data);
      if (candidate.pro_execution_verified === true) break;
      if (candidate.resolved_model_slug && candidate.resolved_model_slug !== MODEL_ID &&
          candidate.message_status === "finished_successfully" && candidate.message_end_turn === true) break;
    }
    await sleep(2_000, signal);
  }
  if (!persisted) throw new Error("ChatGPT conversation could not be read back with the signed browser session");
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
    },
  };
}

function recordProviderAudit(value, responseText) {
  mkdirSync(PROVIDER_AUDIT_DIR, { recursive: true, mode: 0o700 });
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const responsePath = join(PROVIDER_AUDIT_DIR, `${stem}.response.md`);
  writeFileSync(responsePath, responseText, { mode: 0o600 });
  writeJsonAtomic(join(PROVIDER_AUDIT_DIR, `${stem}.json`), { ...value, response_path: responsePath });
}

function verificationFailure(evidence) {
  return `Pro browser execution failed verification: resolved=${String(evidence.resolved_model_slug)} executed=${String(evidence.model_slug)} progress=${String(evidence.pro_progress)} skipped=${String(evidence.pro_skipped)}`;
}

function failureCooldown(error, evidence, warning) {
  const message = `${error instanceof Error ? error.message : String(error)} ${warning}`;
  if (evidence?.resolved_model_slug && evidence.resolved_model_slug !== MODEL_ID) {
    return { cooldownMs: FALLBACK_COOLDOWN_MS, reason: "pro-fallback" };
  }
  if (/rate.?limit|usage limit|quota|too many requests|temporarily unavailable/i.test(message)) {
    return { cooldownMs: RATE_LIMIT_COOLDOWN_MS, reason: "rate-limit" };
  }
  return { cooldownMs: OPERATIONAL_COOLDOWN_MS, reason: "browser-operation" };
}

export async function completeInKernelBrowser(prompt, { signal, maxWaitMs = MAX_WAIT_MS } = {}) {
  await acquireProfile(signal);
  let kernelBrowser = null;
  let playwrightBrowser = null;
  let page = null;
  let evidence = {};
  let responseText = "";
  let warning = "";
  const started = Date.now();
  try {
    kernelBrowser = await createBrowser(signal);
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
        browser_profile: PROFILE_NAME,
      };
    } finally {
      submitted.remove();
    }
    warning = await visibleProviderWarning(page);
    recordProviderAudit({
      at: new Date().toISOString(),
      transport: "kernel-browser-playwright",
      browser_profile: PROFILE_NAME,
      conversation_id: conversationIdFromUrl(page.url()),
      requested_model: MODEL_ID,
      elapsed_sec: (Date.now() - started) / 1000,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      response_chars: responseText.length,
      evidence,
      provider_warning: warning || null,
    }, responseText);
    if (evidence.pro_execution_verified !== true) throw new Error(verificationFailure(evidence));
    await finishProfile({ verified: true }, signal);
    return { text: responseText, evidence };
  } catch (error) {
    warning ||= page ? await visibleProviderWarning(page) : "";
    if (!responseText || Object.keys(evidence).length === 0) {
      recordProviderAudit({
        at: new Date().toISOString(),
        transport: "kernel-browser-playwright",
        browser_profile: PROFILE_NAME,
        requested_model: MODEL_ID,
        elapsed_sec: (Date.now() - started) / 1000,
        prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
        response_chars: responseText.length,
        evidence,
        provider_warning: warning || null,
        error: error instanceof Error ? error.message : String(error),
      }, responseText);
    }
    const cooldown = failureCooldown(error, evidence, warning);
    try { await finishProfile(cooldown, signal?.aborted ? undefined : signal); } catch {}
    throw error;
  } finally {
    // Kernel owns browser termination and profile persistence. Deleting the
    // session also drops the CDP connection; Playwright must not send
    // Browser.close first because that can bypass Kernel's save lifecycle.
    await deleteBrowser(kernelBrowser?.sessionId);
  }
}
