/**
 * Anthropic's OAuth path advertises the Claude Code beta set on every request,
 * including `context-1m-2025-08-07`. The API rejects that beta outright for
 * models without a one-million-token window, answering
 * `The long context beta is not yet available for this subscription.` — a
 * message about the wrong thing, which is why the failure reads as an account
 * problem rather than a header problem. The account is fine; the header is
 * wrong for that model. On GMKtec this made every 200K Anthropic model
 * (`claude-haiku-4-5`, `claude-opus-4-5`) unusable while the 1M models worked.
 *
 * `before_provider_headers` cannot repair it. `@pi-plugins/claude-oauth`
 * installs a `globalThis.fetch` wrapper that unions its own beta list with
 * whatever the request already carries, so a header pi removes is added back.
 * The only place left to stand is underneath that wrapper: this extension
 * wraps fetch first, the plugin wraps ours, and ours therefore sees the final
 * headers on the way out.
 *
 * That makes load order load-bearing. This package must be registered before
 * `claude-oauth` in `config/packages.json`; the ordering test in
 * `guard.test.mjs` states the composition this depends on.
 */
export const LONG_CONTEXT_BETA = "context-1m-2025-08-07";
export const LONG_CONTEXT_WINDOW = 1_000_000;
export const BETA_HEADER = "anthropic-beta";

const INSTALLED = Symbol.for("hara-seihun.anthropic-beta-guard.installed");

/** Returns the header value without the long-context beta, or null when it was the only member. */
export function withoutLongContextBeta(value) {
  if (typeof value !== "string" || !value.includes(LONG_CONTEXT_BETA)) return value;
  const kept = value
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta.length > 0 && beta !== LONG_CONTEXT_BETA);
  return kept.length === 0 ? null : kept.join(",");
}

/** A model earns the beta when its own window is at least the window the beta unlocks. */
export function modelSupportsLongContext(model) {
  const window = model?.contextWindow;
  return typeof window === "number" && window >= LONG_CONTEXT_WINDOW;
}

/**
 * Reads the model out of the outgoing payload rather than session state,
 * because the fetch wrapper runs below pi's request pipeline and a retry or a
 * subagent can carry a different model than the session's current one.
 */
export function modelFromBody(body) {
  if (typeof body !== "string" && !Buffer.isBuffer(body)) return undefined;
  const text = typeof body === "string" ? body : body.toString("utf8");
  const match = text.match(/"model"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

/**
 * Model ids carry no context window at this layer, so the guard asks the
 * registry pi already loaded. An id it cannot find is left alone: stripping a
 * beta from a request that may be entitled to it trades a loud failure for a
 * quiet one.
 */
export function makeWindowLookup(modelRegistry) {
  let windows;
  const build = () => {
    const map = new Map();
    try {
      for (const model of modelRegistry?.getAll?.() ?? []) {
        if (typeof model?.id === "string" && typeof model.contextWindow === "number") {
          map.set(model.id, model.contextWindow);
        }
      }
    } catch {
      // An unreadable registry leaves every request untouched, which is the
      // same outcome as not installing the guard at all.
    }
    return map;
  };
  return (id) => {
    if (id === undefined) return undefined;
    windows ??= build();
    return windows.get(id);
  };
}

export function wrapFetchWithBetaGuard(base, lookupWindow) {
  return (input, init) => {
    const headers = init?.headers;
    if (headers === undefined) return base(input, init);
    const list = headers instanceof Headers ? headers : new Headers(headers);
    const current = list.get(BETA_HEADER);
    if (current === null || !current.includes(LONG_CONTEXT_BETA)) return base(input, init);
    const window = lookupWindow(modelFromBody(init?.body));
    if (window === undefined || modelSupportsLongContext({ contextWindow: window })) {
      return base(input, init);
    }
    const next = withoutLongContextBeta(current);
    if (next === null) list.delete(BETA_HEADER);
    else list.set(BETA_HEADER, next);
    return base(input, { ...init, headers: list });
  };
}

export function installBetaGuard(target, lookupWindow) {
  if (target[INSTALLED] === true || typeof target.fetch !== "function") return false;
  target.fetch = wrapFetchWithBetaGuard(target.fetch.bind(target), lookupWindow);
  target[INSTALLED] = true;
  return true;
}

export default function (pi) {
  let lookup = () => undefined;
  installBetaGuard(globalThis, (id) => lookup(id));
  pi.on("session_start", (_event, ctx) => {
    lookup = makeWindowLookup(ctx?.modelRegistry);
  });
}
