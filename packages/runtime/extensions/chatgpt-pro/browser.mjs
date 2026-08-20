import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi", "agent");
const POOL_PATH = join(AGENT_DIR, "chatgpt-pro-pool.json");
const ORCHESTRATOR_LEDGER_PATH = join(HOME, ".local", "share", "pi-orchestrator", "ledger.sqlite3");
const POOL_LOCK = join(AGENT_DIR, ".chatgpt-pro-pool.lock");
const PROVIDER_AUDIT_DIR = join(HOME, "data", "chatgpt-pro", "provider-audit");
const ALERTS_INBOX = join(HOME, "data", "alerts", "inbox");
const PENDING_DIR = join(HOME, "data", "chatgpt-pro", "pending");
const RECOVERED_DIR = join(HOME, "data", "projects-research", "pro", "recovered");
export const PRO_PROFILE_CONFIG_PATH = join(AGENT_DIR, "chatgpt-pro-profiles.json");
export const PRO_MAX_PARALLEL = 4;
const DEFAULT_PROFILE_NAME = "limmy-google";
const MODEL_ID = "gpt-5-6-pro";
export const PRO_TRANSPORT_HORIZONS = Object.freeze({
  responseWaitMs: 3 * 60 * 60_000,
  stalledWorkMs: 60 * 60_000,
  persistedPollMs: 20 * 60_000,
  browserTimeoutSeconds: 5 * 60,
  accountLeaseMs: 3 * 60 * 60_000 + 20 * 60_000,
});
const ACCOUNT_LEASE_MS = PRO_TRANSPORT_HORIZONS.accountLeaseMs;
// A mini-routed Pro submission means the account's Pro allowance is exhausted;
// rest the account for a full day and round-robin the others.
export const FALLBACK_COOLDOWN_MS = 24 * 60 * 60_000;
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

// Subscription lifecycle custody lives in the pi-orchestrator account ledger
// (account.access_until on cancelled subscriptions). A missing ledger means no
// lifecycle information, matching the historical missing-file tolerance; a
// present but unreadable ledger is a real error and must not silently admit a
// profile whose paired subscription lapses mid-turn.
export function subscriptionLifecycleFromLedger(path = ORCHESTRATOR_LEDGER_PATH) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return {};
  }
  try {
    const rows = db
      .prepare("SELECT id, access_until FROM account WHERE provider = 'openai-codex' AND access_until IS NOT NULL")
      .all();
    const subscriptions = [];
    for (const row of rows) {
      const match = /^openai-codex-([0-9]+)$/.exec(String(row.id));
      if (match === null) continue;
      subscriptions.push({
        provider: "openai-codex",
        index: Number(match[1]),
        lifecycle: { state: "cancelled", accessUntil: new Date(Number(row.access_until)).toISOString() },
      });
    }
    return { subscriptions };
  } finally {
    db.close();
  }
}

export function profileNamesAllowedByLifecycle(
  names,
  profileProviders,
  lifecycleConfig,
  at = Date.now(),
  minimumRemainingMs = 0,
) {
  const accessUntilByProvider = new Map();
  for (const entry of Array.isArray(lifecycleConfig?.subscriptions) ? lifecycleConfig.subscriptions : []) {
    if (entry?.provider !== "openai-codex" || !Number.isInteger(entry.index) || entry.index < 2 || entry.lifecycle === undefined) continue;
    if (entry.lifecycle?.state !== "cancelled" || typeof entry.lifecycle?.accessUntil !== "string") {
      throw new Error(`invalid subscription lifecycle for openai-codex-${entry.index}`);
    }
    const accessUntil = Date.parse(entry.lifecycle.accessUntil);
    if (!Number.isFinite(accessUntil)) throw new Error(`invalid subscription accessUntil for openai-codex-${entry.index}`);
    accessUntilByProvider.set(`openai-codex-${entry.index}`, accessUntil);
  }
  return names.filter((name) => {
    const provider = profileProviders?.[name];
    const accessUntil = provider ? accessUntilByProvider.get(provider) : undefined;
    return accessUntil === undefined || accessUntil > at + minimumRemainingMs;
  });
}

export function configuredProfileNames(at = Date.now(), minimumRemainingMs = 0) {
  let names = [DEFAULT_PROFILE_NAME];
  let profileProviders = {};
  try {
    const raw = JSON.parse(readFileSync(PRO_PROFILE_CONFIG_PATH, "utf8"));
    if (raw?.version !== 1 || !Array.isArray(raw.profiles)) throw new Error("expected version 1 with a profiles array");
    names = raw.profiles;
    profileProviders = raw.profileProviders ?? {};
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Invalid ChatGPT Pro profile config: ${error.message}`);
  }
  if (names.length < 1 || names.length > PRO_MAX_PARALLEL ||
      names.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) ||
      new Set(names).size !== names.length ||
      !profileProviders || typeof profileProviders !== "object" || Array.isArray(profileProviders) ||
      Object.entries(profileProviders).some(([name, provider]) => !names.includes(name) || !/^openai-codex-[2-9][0-9]*$/.test(provider))) {
    throw new Error(`ChatGPT Pro profile config must contain 1-${PRO_MAX_PARALLEL} unique Kernel profile names and valid Codex provider mappings`);
  }
  const lifecycleConfig = subscriptionLifecycleFromLedger();
  const allowed = profileNamesAllowedByLifecycle(names, profileProviders, lifecycleConfig, at, minimumRemainingMs);
  if (allowed.length === 0) return [];
  return allowed;
}

function defaultProfileState(browserProfile) {
  return {
    browserProfile,
    selectionCount: 0,
    inFlightUntil: 0,
    cooldownUntil: 0,
    cooldownReason: null,
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

export function currentPoolCapacity(at = Date.now()) {
  return browserPoolCapacitySnapshot(readPoolState(), at);
}

export function browserPoolCapacitySnapshot(raw, at = Date.now(), profileNames) {
  const suppliedNames = profileNames !== undefined;
  const activeNames = suppliedNames ? profileNames : configuredProfileNames(at);
  const leaseEligible = new Set(suppliedNames ? activeNames : configuredProfileNames(at, ACCOUNT_LEASE_MS));
  const state = normalizePoolState(raw, activeNames);
  const inFlight = state.profiles.filter((profile) => profile.inFlightUntil > at).length;
  const eligible = state.profiles.filter((profile) => leaseEligible.has(profile.browserProfile) && profile.cooldownUntil <= at).length;
  const available = state.profiles.filter((profile) => leaseEligible.has(profile.browserProfile) && profile.cooldownUntil <= at && profile.inFlightUntil <= at).length;
  return { configured: state.profiles.length, eligible, inFlight, available, maxParallel: PRO_MAX_PARALLEL };
}

async function acquireProfile(signal) {
  return withDirectoryLock(POOL_LOCK, signal, () => {
    const state = readPoolState();
    const at = Date.now();
    const leaseEligible = new Set(configuredProfileNames(at, ACCOUNT_LEASE_MS));
    const selected = state.profiles
      .filter((profile) => leaseEligible.has(profile.browserProfile) && profile.cooldownUntil <= at && profile.inFlightUntil <= at)
      .sort((left, right) => left.selectionCount - right.selectionCount || left.browserProfile.localeCompare(right.browserProfile))[0];
    if (!selected) {
      const snapshot = browserPoolCapacitySnapshot(state, at);
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
      selected.lastFallbackAt = null;
      selected.lastVerifiedAt = new Date().toISOString();
    } else if (cooldownMs > 0) {
      if (reason === "pro-fallback") selected.lastFallbackAt = new Date().toISOString();
      selected.cooldownUntil = Date.now() + cooldownMs;
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

async function createBrowser(browserProfile, signal, startUrl = "https://chatgpt.com/") {
  const stdout = await kernel([
    "browsers", "create",
    "--profile-name", browserProfile,
    "--save-changes",
    "--start-url", startUrl,
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
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await kernel(["browsers", "delete", sessionId], { timeout: 60_000 });
      return;
    } catch (error) {
      failure = error;
      if (attempt < 3) await sleep(1_000 * attempt);
    }
  }
  throw new Error(`Could not delete billable Kernel browser ${sessionId}: ${failure instanceof Error ? failure.message : String(failure)}`);
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

function conversationIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/c\/([^/]+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// A ChatGPT web-UI shape change (missing picker, changed labels, blocking
// modal) must fail loudly and distinctly — not as a generic browser-operation
// error that quietly cools down and retries. The 2026-08-19 incident burned
// three entitlements in three minutes on an undetected one-time interstitial
// whose backdrop intercepted the send click.
export class ProUiChangedError extends Error {
  constructor(stage, detail, { screenshotPath = null } = {}) {
    super(`ChatGPT UI changed at ${stage}: ${detail}`);
    this.code = "pro-ui-changed";
    this.stage = stage;
    this.screenshotPath = screenshotPath;
  }
}

function writeUiChangeAlert(error, browserProfile) {
  mkdirSync(ALERTS_INBOX, { recursive: true });
  const path = join(ALERTS_INBOX,
    `chatgpt-pro-ui-changed-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.md`);
  writeFileSync(path, [
    "# ChatGPT Pro UI changed",
    "",
    `- At: ${new Date().toISOString()}`,
    `- Stage: ${error.stage}`,
    `- Browser profile: ${browserProfile ?? "unknown"}`,
    `- Screenshot: ${error.screenshotPath ?? "unavailable"}`,
    "",
    "## Observed",
    "",
    error.message,
    "",
    "The chatgpt.com web UI no longer matches what the chatgpt-pro provider",
    "expects at this stage. Every Pro moonshot lane is likely broken until the",
    "provider is updated. See the UI contract in",
    "`/home/kenan/tools/pi-runtime/extensions/chatgpt-pro/README.md` and repair",
    "`browser.mjs` against the current DOM (the screenshot shows the observed",
    "state).",
  ].join("\n"), { mode: 0o600 });
}

async function uiChangedError(page, stage, detail, browserProfile = null) {
  let screenshotPath = null;
  try {
    mkdirSync(PROVIDER_AUDIT_DIR, { recursive: true, mode: 0o700 });
    screenshotPath = join(PROVIDER_AUDIT_DIR,
      `ui-changed-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.png`);
    await page.screenshot({ path: screenshotPath, timeout: 10_000 });
  } catch {
    screenshotPath = null;
  }
  const error = new ProUiChangedError(stage, detail, { screenshotPath });
  try { writeUiChangeAlert(error, browserProfile); } catch {}
  return error;
}

// Anything shaped like a full-screen dialog backdrop. ChatGPT renders one-time
// interstitials (announcements, onboarding) under #modal-beacon with a
// data-state="open" backdrop that intercepts pointer events page-wide.
const MODAL_BACKDROP = '#modal-beacon [data-state="open"], div[data-state="open"].fixed.inset-0';
const MODAL_CLOSE_BUTTONS = [
  '#modal-beacon [data-testid="close-button"], [role="dialog"] [data-testid="close-button"]',
  '#modal-beacon button[aria-label*="close" i], [role="dialog"] button[aria-label*="close" i], button[aria-label*="dismiss" i]',
];
const MODAL_BENIGN_TEXT = /^(Close|Dismiss|Got it|OK|Okay|Continue|Maybe later|Not now|Skip|No thanks)$/i;

async function dismissBlockingModals(page, stage, browserProfile = null) {
  const backdrop = page.locator(MODAL_BACKDROP).first();
  if (!(await backdrop.isVisible().catch(() => false))) return false;
  const modalText = ((await page.locator("#modal-beacon").innerText().catch(() => "")) ||
    (await page.locator('[role="dialog"]').first().innerText().catch(() => "")))
    .replace(/\s+/g, " ").trim().slice(0, 500);
  for (const selector of MODAL_CLOSE_BUTTONS) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (!(await backdrop.isVisible().catch(() => false))) return true;
    }
  }
  const benign = page.locator('#modal-beacon button, [role="dialog"] button')
    .filter({ hasText: MODAL_BENIGN_TEXT }).first();
  if (await benign.isVisible().catch(() => false)) {
    await benign.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (!(await backdrop.isVisible().catch(() => false))) return true;
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  if (!(await backdrop.isVisible().catch(() => false))) return true;
  throw await uiChangedError(page, stage,
    `blocking modal could not be dismissed (close buttons and Escape all failed): ${modalText || "(no dialog text)"}`,
    browserProfile);
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

// Element-shape steps: a timeout or mismatch here means the web UI no longer
// matches the provider's contract, which is a loud ProUiChangedError — never a
// generic failure. Navigation and authentication failures stay generic.
async function uiStep(page, stage, detail, action, browserProfile) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ProUiChangedError) throw error;
    throw await uiChangedError(page, stage, `${detail}: ${error?.message ?? String(error)}`, browserProfile);
  }
}

async function ensureProSelection(page, browserProfile = null) {
  const composer = page.locator("#prompt-textarea");
  await uiStep(page, "composer", "prompt textarea did not appear",
    () => composer.waitFor({ state: "visible", timeout: 30_000 }), browserProfile);
  await dismissBlockingModals(page, "before-picker", browserProfile);
  const picker = page.getByRole("button", { name: /^(Instant|Medium|High|Extra High|Pro)$/ }).last();
  await uiStep(page, "model-picker-button", "intelligence picker button missing",
    () => picker.waitFor({ state: "visible", timeout: 15_000 }), browserProfile);
  await uiStep(page, "model-picker-button", "picker button click blocked",
    () => picker.click({ timeout: 15_000 }), browserProfile);
  const content = page.locator('[data-testid="composer-intelligence-picker-content"]');
  await uiStep(page, "picker-content", "picker content did not open",
    () => content.waitFor({ state: "visible", timeout: 10_000 }), browserProfile);
  const power = page.getByRole("menuitem", { name: "Power" });
  await uiStep(page, "power-menuitem", "Power menu item missing from picker",
    () => power.waitFor({ state: "visible", timeout: 10_000 }), browserProfile);
  const slider = power.locator('[role="slider"]');
  let value = Number(await slider.getAttribute("aria-valuenow"));
  const max = Number(await slider.getAttribute("aria-valuemax"));
  if (!Number.isInteger(value) || !Number.isInteger(max) || max < 1) {
    throw await uiChangedError(page, "power-slider",
      `slider exposed no verifiable value range (valuenow=${value}, valuemax=${max})`, browserProfile);
  }
  await power.focus();
  while (value < max) {
    await power.press("ArrowRight");
    await page.waitForTimeout(200);
    const next = Number(await slider.getAttribute("aria-valuenow"));
    if (!Number.isInteger(next) || next <= value) {
      throw await uiChangedError(page, "power-slider",
        `slider did not advance toward Pro (stuck at ${value} of ${max})`, browserProfile);
    }
    value = next;
  }
  await page.waitForTimeout(500);
  const pickerText = (await content.innerText()).replace(/\s+/g, " ").trim();
  if (!/Pro,\s*5 of 5/i.test(pickerText) || !/GPT-5\.6 Sol/i.test(pickerText) || !/Effort\s+Pro/i.test(pickerText)) {
    throw await uiChangedError(page, "picker-verification",
      `picker did not verify GPT-5.6 Sol Pro: ${pickerText.slice(0, 500)}`, browserProfile);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const selected = (await page.getByRole("button", { name: /^(Instant|Medium|High|Extra High|Pro)$/ }).last().innerText()).trim();
  if (selected !== "Pro") {
    throw await uiChangedError(page, "picker-close",
      `picker closed on ${JSON.stringify(selected)}, not Pro`, browserProfile);
  }
  return { selected, pickerText };
}

function pendingPath(conversationId) {
  return join(PENDING_DIR, `${conversationId.replaceAll("/", "_").replaceAll(":", "_")}.json`);
}

function writePendingConversation(entry) {
  mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 });
  writeJsonAtomic(pendingPath(entry.conversationId), entry);
}

function clearPendingConversation(conversationId) {
  try { unlinkSync(pendingPath(conversationId)); } catch {}
}

export function listPendingConversations() {
  let names = [];
  try { names = readdirSync(PENDING_DIR); } catch { return []; }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try { entries.push(JSON.parse(readFileSync(join(PENDING_DIR, name), "utf8"))); } catch {}
  }
  return entries.filter((entry) => entry?.conversationId && entry?.browserProfile);
}

async function submitPrompt(page, prompt, browserProfile = null) {
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
    await uiStep(page, "send-button", "send button did not appear after prompt insertion",
      () => send.waitFor({ state: "visible", timeout: 15_000 }), browserProfile);
    if (!(await send.isEnabled())) {
      throw await uiChangedError(page, "send-button",
        "send button remained disabled after prompt insertion", browserProfile);
    }
    await dismissBlockingModals(page, "before-send", browserProfile);
    try {
      await send.click({ timeout: 30_000 });
    } catch (clickError) {
      if (clickError instanceof ProUiChangedError) throw clickError;
      // A backdrop can open between the sweep and the click (the 2026-08-19
      // interstitial did exactly this). Dismiss deliberately and retry once;
      // a second interception is a loud UI-change failure.
      await dismissBlockingModals(page, "send-click-intercepted", browserProfile);
      await uiStep(page, "send-click-blocked",
        `send click still blocked after modal dismissal (first failure: ${clickError?.message?.split("\n")[0] ?? clickError})`,
        () => send.click({ timeout: 15_000 }), browserProfile);
    }
    await page.waitForURL((url) => conversationIdFromUrl(url.toString()) !== null, { timeout: 120_000 });
    return { conversationId: conversationIdFromUrl(page.url()), observed, responsePromise, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

async function readPersistedConversation(page, conversationId) {
  // New web conversations carry a WEB: URL prefix that the backend API rejects.
  conversationId = conversationId.replace(/^WEB:/i, "");
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

async function listRecentConversations(page, limit = 50) {
  return page.evaluate(async ({ limit }) => {
    const sessionResponse = await fetch("/api/auth/session", { credentials: "include" });
    const session = await sessionResponse.json().catch(() => null);
    if (!session?.accessToken) return { status: 401, items: [] };
    const response = await fetch(`/backend-api/conversations?offset=0&limit=${limit}&order=updated`, {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "chatgpt-account-id": session.account?.id || "",
      },
    });
    const body = response.ok ? await response.json() : null;
    return { status: response.status, items: Array.isArray(body?.items) ? body.items.map((item) => item.id) : [] };
  }, { limit });
}

export function firstUserMessageText(data) {
  let earliest = null;
  for (const node of Object.values(data?.mapping ?? {})) {
    const message = node?.message;
    if (!message || message.author?.role !== "user") continue;
    const time = Number(message.create_time) || 0;
    if (earliest === null || time < earliest.time) {
      const parts = message.content?.parts;
      earliest = { time, text: Array.isArray(parts) ? parts.filter((part) => typeof part === "string").join("\n") : "" };
    }
  }
  return earliest?.text ?? "";
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

async function waitForPersistedEvidence(browserProfile, submitted, signal, maxWaitMs = MAX_WAIT_MS) {
  const started = Date.now();
  const deadline = started + maxWaitMs;
  let persisted = null;
  let evidence = {};
  let activityMarker = null;
  let lastActivityAt = started;
  let stalled = false;
  let timedOut = false;
  let stopRequested = false;
  let warning = "";
  let pollCount = 0;

  // ChatGPT continues Pro reasoning server-side after the submitting browser is
  // deleted. Keep only the logical entitlement lease between observations:
  // every twenty minutes, open a short-lived browser, read the authoritative
  // persisted conversation once, and delete the browser immediately.
  while (Date.now() < deadline) {
    await sleep(Math.min(PRO_TRANSPORT_HORIZONS.persistedPollMs, deadline - Date.now()), signal);
    signal?.throwIfAborted();
    pollCount += 1;
    let kernelBrowser = null;
    let page = null;
    try {
      const conversationUrl = `https://chatgpt.com/c/${encodeURIComponent(submitted.conversationId)}`;
      kernelBrowser = await createBrowser(browserProfile, signal, conversationUrl);
      const playwrightBrowser = await chromium.connectOverCDP(kernelBrowser.cdpUrl, { timeout: 60_000 });
      const context = playwrightBrowser.contexts()[0];
      if (!context) throw new Error("Kernel CDP endpoint exposed no browser context during Pro status poll");
      page = context.pages()[0] ?? await context.newPage();
      await page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await checkAuthentication(page);
      const result = await readPersistedConversation(page, submitted.conversationId);
      warning ||= await visibleProviderWarning(page);
      if (result.data) {
        persisted = result.data;
        evidence = conversationModelEvidence(result.data);
        if (isTerminalConversationEvidence(evidence)) break;
        const marker = conversationActivityMarker(result.data, evidence);
        if (marker !== activityMarker) {
          activityMarker = marker;
          lastActivityAt = Date.now();
        } else if (Date.now() - lastActivityAt >= PRO_TRANSPORT_HORIZONS.stalledWorkMs) {
          stalled = true;
          stopRequested = await stopActiveResponse(page);
          break;
        }
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        stopRequested = await stopActiveResponse(page);
        break;
      }
    } finally {
      await deleteBrowser(kernelBrowser?.sessionId);
    }
  }

  if (!persisted) throw new Error("ChatGPT conversation could not be read back during periodic signed-browser checks");
  return {
    text: conversationLeafText(persisted).trim(),
    warning,
    evidence: {
      ...evidence,
      submission_response_status: submitted.responseStatus,
      transport_poll_interval_ms: PRO_TRANSPORT_HORIZONS.persistedPollMs,
      transport_poll_count: pollCount,
      transport_stalled: stalled,
      transport_timed_out: timedOut,
      transport_stop_requested: stopRequested,
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

export function failureCooldown(error, evidence, warning) {
  const message = `${error instanceof Error ? error.message : String(error)} ${warning}`;
  if (error?.code === "pro-ui-changed") {
    // Loud and distinct: the alert is already in the inbox; the short cooldown
    // only stops a tight retry loop against a UI the provider cannot drive.
    return { cooldownMs: OPERATIONAL_COOLDOWN_MS, reason: "pro-ui-changed" };
  }
  if (evidence?.transport_stalled === true || evidence?.transport_timed_out === true) {
    return {
      cooldownMs: 4 * 60 * 60_000,
      reason: evidence.transport_stalled === true ? "pro-stalled" : "pro-timeout",
    };
  }
  if (evidence?.resolved_model_slug && evidence.resolved_model_slug !== MODEL_ID) {
    return { cooldownMs: FALLBACK_COOLDOWN_MS, reason: "pro-fallback" };
  }
  if (/rate.?limit|usage limit|quota|too many requests|temporarily unavailable/i.test(message)) {
    return { cooldownMs: RATE_LIMIT_COOLDOWN_MS, reason: "rate-limit" };
  }
  return { cooldownMs: OPERATIONAL_COOLDOWN_MS, reason: "browser-operation" };
}

// The router can silently resolve a submission to a non-Pro model. The POST
// /conversation SSE body reveals resolved_model_slug within seconds; reading
// it here converts a would-be twenty-minute poll discovery into an immediate
// tagged failure the caller can retry on another entitlement.
export function streamResolvedModel(streamText) {
  return streamText?.match(/"resolved_model_slug"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

// The /c/WEB:... URL segment is an optimistic client placeholder; only the
// submission SSE stream carries the server conversation id that the backend
// API accepts.
export function streamConversationId(streamText) {
  return streamText?.match(/"conversation_id"\s*:\s*"([0-9a-f-]{36})"/i)?.[1] ?? null;
}

class ProFallbackError extends Error {
  constructor(resolved) {
    super(`ChatGPT router resolved ${resolved} instead of ${MODEL_ID}; the Pro turn never ran`);
    this.code = "pro-fallback-early";
    this.resolved = resolved;
  }
}

async function attemptProTurn(browserProfile, prompt, { signal, maxWaitMs, onStatus, auditContext, started }) {
  let submitted = null;
  let selection = null;
  let evidence = {};
  let responseText = "";
  let warning = "";
  try {
    let submissionBrowser = null;
    let streamText = "";
    try {
      submissionBrowser = await createBrowser(browserProfile, signal);
      const playwrightBrowser = await chromium.connectOverCDP(submissionBrowser.cdpUrl, { timeout: 60_000 });
      const context = playwrightBrowser.contexts()[0];
      if (!context) throw new Error("Kernel CDP endpoint exposed no browser context");
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await checkAuthentication(page);
      selection = await ensureProSelection(page, browserProfile);
      submitted = await submitPrompt(page, prompt, browserProfile);
      try {
        const response = await withDeadline(submitted.responsePromise, 120_000, signal);
        submitted.responseStatus = response.status();
        if (submitted.responseStatus < 200 || submitted.responseStatus >= 300) {
          throw new Error(`ChatGPT rejected the Pro submission with HTTP ${submitted.responseStatus}`);
        }
        if (submitted.observed.requestedModel !== MODEL_ID) {
          throw new Error(`ChatGPT submitted unexpected model ${String(submitted.observed.requestedModel)}`);
        }
        try { streamText = await withDeadline(response.text(), 90_000, signal); } catch {}
        warning = await visibleProviderWarning(page);
      } finally {
        submitted.remove();
      }
    } finally {
      // The POST has been accepted and ChatGPT owns the asynchronous work. End
      // the billable Kernel minute immediately; never hold this browser while
      // Pro reasons server-side.
      await deleteBrowser(submissionBrowser?.sessionId);
    }

    const resolvedEarly = streamResolvedModel(streamText);
    if (resolvedEarly && resolvedEarly !== MODEL_ID) {
      evidence = { resolved_model_slug: resolvedEarly, stream_resolved_model_slug: resolvedEarly };
      throw new ProFallbackError(resolvedEarly);
    }
    const serverConversationId = streamConversationId(streamText);
    if (serverConversationId) submitted.conversationId = serverConversationId;

    writePendingConversation({
      conversationId: submitted.conversationId,
      browserProfile,
      caller: auditContext,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      submittedAt: new Date().toISOString(),
    });
    onStatus?.({ phase: "submitted", browserProfile, nextCheckMs: PRO_TRANSPORT_HORIZONS.persistedPollMs });
    const verified = await waitForPersistedEvidence(browserProfile, submitted, signal, maxWaitMs);
    responseText = verified.text;
    warning ||= verified.warning;
    evidence = {
      ...verified.evidence,
      stream_resolved_model_slug: streamResolvedModel(streamText) ?? undefined,
      outgoing_model: submitted.observed.requestedModel,
      picker_selected: selection.selected,
      picker_model: "GPT-5.6 Sol",
      picker_effort: "Pro",
      browser_profile: browserProfile,
    };
    const audit = recordProviderAudit({
      at: new Date().toISOString(),
      transport: "kernel-browser-submit-periodic-poll",
      browser_profile: browserProfile,
      conversation_id: submitted.conversationId,
      requested_model: MODEL_ID,
      caller: auditContext,
      elapsed_sec: (Date.now() - started) / 1000,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      response_chars: responseText.length,
      evidence,
      provider_warning: warning || null,
    }, responseText);
    clearPendingConversation(submitted.conversationId);
    if (evidence.pro_execution_verified !== true) throw new Error(verificationFailure(evidence));
    await finishProfile(browserProfile, { verified: true }, signal);
    return { text: responseText, evidence, audit, browserProfile };
  } catch (error) {
    // An abort mid-poll leaves the pending record in place on purpose: the
    // conversation keeps reasoning server-side and pro-recover harvests it.
    if (submitted?.conversationId && !(signal?.aborted)) clearPendingConversation(submitted.conversationId);
    if (!responseText || Object.keys(evidence).length === 0 || error instanceof ProFallbackError) {
      recordProviderAudit({
        at: new Date().toISOString(),
        transport: "kernel-browser-submit-periodic-poll",
        browser_profile: browserProfile,
        conversation_id: submitted?.conversationId ?? null,
        requested_model: MODEL_ID,
        caller: auditContext,
        elapsed_sec: (Date.now() - started) / 1000,
        prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
        response_chars: responseText.length,
        evidence,
        provider_warning: warning || null,
        error: error instanceof Error ? error.message : String(error),
        error_code: error?.code ?? null,
        ui_stage: error?.stage ?? undefined,
        ui_screenshot: error?.screenshotPath ?? undefined,
      }, responseText);
    }
    const cooldown = error instanceof ProFallbackError
      ? { cooldownMs: FALLBACK_COOLDOWN_MS, reason: "pro-fallback" }
      : failureCooldown(error, evidence, warning);
    try { await finishProfile(browserProfile, cooldown, signal?.aborted ? undefined : signal); } catch {}
    throw error;
  }
}

export async function completeInKernelBrowser(prompt, { signal, maxWaitMs = MAX_WAIT_MS, onStatus, auditContext = null } = {}) {
  const started = Date.now();
  const tried = new Set();
  // Router fallbacks are account-transient: rotate through distinct
  // entitlements before conceding, so one flaky resolution does not fail a
  // whole delegated attack.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const browserProfile = await acquireProfile(signal);
    tried.add(browserProfile);
    try {
      const state = readPoolState();
      onStatus?.({
        phase: attempt === 1 ? "running" : "retrying-after-fallback",
        browserProfile,
        capacity: browserPoolCapacitySnapshot(state, Date.now()),
      });
    } catch {}
    try {
      return await attemptProTurn(browserProfile, prompt, { signal, maxWaitMs, onStatus, auditContext, started });
    } catch (error) {
      if (!(error instanceof ProFallbackError) || attempt === 3) throw error;
      signal?.throwIfAborted();
    }
  }
  throw new Error("unreachable: Pro attempt loop exited");
}

// Audits are the historical record of submissions that predate the pending
// registry. A conversation is orphaned when its only records are aborts or
// nonterminal errors: no verified, recovered, or terminal-fallback audit.
export function orphanedConversationsFromAudits(days = 7, auditDir = PROVIDER_AUDIT_DIR) {
  let names = [];
  try { names = readdirSync(auditDir); } catch { return []; }
  const cutoff = Date.now() - days * 86_400_000;
  const byConversation = new Map();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record;
    try { record = JSON.parse(readFileSync(join(auditDir, name), "utf8")); } catch { continue; }
    const conversationId = record?.conversation_id;
    if (!conversationId) continue;
    const at = Date.parse(record.at ?? "");
    const entry = byConversation.get(conversationId) ?? { terminal: false, latest: null, latestAt: 0 };
    const evidence = record.evidence ?? {};
    if (evidence.pro_execution_verified === true || record.recovered === true ||
        (evidence.resolved_model_slug && evidence.resolved_model_slug !== "gpt-5-6-pro")) {
      entry.terminal = true;
    }
    if (Number.isFinite(at) && at > entry.latestAt) {
      entry.latestAt = at;
      entry.latest = record;
    }
    byConversation.set(conversationId, entry);
  }
  const orphans = [];
  for (const [conversationId, entry] of byConversation) {
    if (entry.terminal || entry.latestAt < cutoff || !entry.latest?.browser_profile) continue;
    orphans.push({
      conversationId,
      browserProfile: entry.latest.browser_profile,
      caller: entry.latest.caller ?? null,
      prompt_sha256: entry.latest.prompt_sha256 ?? null,
    });
  }
  return orphans;
}

// Harvest conversations whose submitting launch died (controller restart,
// abort) while ChatGPT kept reasoning server-side. Verified responses become
// ordinary provider audits plus research-visible recovered artifacts.
export async function recoverPendingProConversations({ signal, extra = [], log = () => {} } = {}) {
  const seen = new Set();
  const candidates = [];
  for (const entry of [...listPendingConversations(), ...extra]) {
    if (!entry?.conversationId || seen.has(entry.conversationId)) continue;
    seen.add(entry.conversationId);
    candidates.push(entry);
  }
  const results = [];
  const consumed = new Set();
  for (const entry of candidates) {
    signal?.throwIfAborted();
    let kernelBrowser = null;
    let outcome = "unreadable";
    try {
      const conversationUrl = `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}`;
      kernelBrowser = await createBrowser(entry.browserProfile, signal, conversationUrl);
      const playwrightBrowser = await chromium.connectOverCDP(kernelBrowser.cdpUrl, { timeout: 60_000 });
      const context = playwrightBrowser.contexts()[0];
      if (!context) throw new Error("Kernel CDP endpoint exposed no browser context during Pro recovery");
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await checkAuthentication(page);
      let result = await readPersistedConversation(page, entry.conversationId);
      // Placeholder ids cannot be read directly; find the real conversation by
      // matching the recorded prompt hash against the account's recent history.
      if (!result.data && entry.prompt_sha256) {
        const listing = await listRecentConversations(page);
        for (const candidateId of listing.items) {
          if (consumed.has(candidateId)) continue;
          const candidate = await readPersistedConversation(page, candidateId);
          if (!candidate.data) continue;
          const sha = createHash("sha256").update(firstUserMessageText(candidate.data)).digest("hex");
          if (sha === entry.prompt_sha256) {
            result = candidate;
            entry.matchedConversationId = candidateId;
            consumed.add(candidateId);
            break;
          }
        }
      }
      if (!result.data) throw new Error(`persisted conversation read returned HTTP ${result.status}`);
      const evidence = conversationModelEvidence(result.data);
      const text = conversationLeafText(result.data).trim();
      const recoveredId = entry.matchedConversationId ?? entry.conversationId;
      if (evidence.pro_execution_verified === true) {
        outcome = "recovered-verified";
        const audit = recordProviderAudit({
          at: new Date().toISOString(),
          transport: "pro-recovery-poll",
          recovered: true,
          browser_profile: entry.browserProfile,
          conversation_id: recoveredId,
          placeholder_conversation_id: entry.matchedConversationId ? entry.conversationId : undefined,
          requested_model: MODEL_ID,
          caller: entry.caller ?? null,
          prompt_sha256: entry.prompt_sha256 ?? null,
          response_chars: text.length,
          evidence,
        }, text);
        mkdirSync(RECOVERED_DIR, { recursive: true, mode: 0o700 });
        const recoveredPath = join(RECOVERED_DIR,
          `${new Date().toISOString().replace(/[:.]/g, "-")}-${recoveredId.slice(-8)}.md`);
        writeFileSync(recoveredPath, [
          "# Recovered GPT-5.6 Pro response",
          "",
          `- Conversation: ${recoveredId}`,
          `- Browser profile: ${entry.browserProfile}`,
          `- Caller: ${JSON.stringify(entry.caller ?? null)}`,
          `- Prompt SHA-256: ${entry.prompt_sha256 ?? "unknown"}`,
          `- Verified evidence: pro_execution_verified=true (audit: ${audit.auditPath})`,
          "- Standing: advisory only; every load-bearing step requires tool-capable validation.",
          "",
          "## Response",
          "",
          text,
        ].join("\n"), { mode: 0o600 });
        clearPendingConversation(entry.conversationId);
        try { await finishProfile(entry.browserProfile, { verified: true }, signal); } catch {}
        results.push({ conversationId: recoveredId, outcome, recoveredPath, auditPath: audit.auditPath, chars: text.length });
      } else if (isTerminalConversationEvidence(evidence)) {
        outcome = "terminal-not-pro";
        recordProviderAudit({
          at: new Date().toISOString(),
          transport: "pro-recovery-poll",
          recovered: true,
          browser_profile: entry.browserProfile,
          conversation_id: recoveredId,
          requested_model: MODEL_ID,
          caller: entry.caller ?? null,
          prompt_sha256: entry.prompt_sha256 ?? null,
          response_chars: text.length,
          evidence,
          error: verificationFailure(evidence),
        }, text);
        clearPendingConversation(entry.conversationId);
        results.push({ conversationId: entry.conversationId, outcome, chars: text.length });
      } else {
        outcome = "still-working";
        results.push({ conversationId: entry.conversationId, outcome });
      }
    } catch (error) {
      results.push({ conversationId: entry.conversationId, outcome: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      try { await deleteBrowser(kernelBrowser?.sessionId); } catch {}
      log(results[results.length - 1]);
    }
  }
  return results;
}
