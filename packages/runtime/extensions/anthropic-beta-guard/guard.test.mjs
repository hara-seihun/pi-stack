import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { patchClaudeOauthSource } from "../../patch-claude-oauth.mjs";

const require = createRequire(import.meta.url);
const adapterSource = readFileSync(require.resolve("@pi-plugins/claude-oauth"), "utf8");
const { default: claudeOauth } = await import(`data:text/javascript;base64,${Buffer.from(patchClaudeOauthSource(adapterSource)).toString("base64")}`);
import {
  BETA_HEADER,
  LONG_CONTEXT_BETA,
  installBetaGuard,
  makeWindowLookup,
  modelFromBody,
  modelSupportsLongContext,
  withoutLongContextBeta,
  wrapFetchWithBetaGuard,
} from "./index.mjs";

const FULL = `claude-code-20250219,oauth-2025-04-20,${LONG_CONTEXT_BETA},interleaved-thinking-2025-05-14`;
const TRIMMED = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14";

const registry = {
  getAll: () => [
    { id: "claude-haiku-4-5", contextWindow: 200_000 },
    { id: "claude-fable-5-1", contextWindow: 1_000_000 },
    { id: "gpt-6-astra", contextWindow: 272_000 },
  ],
};

function capture(lookup) {
  const seen = [];
  const base = (input, init) => {
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers ?? {});
    seen.push(headers.get(BETA_HEADER));
    return Promise.resolve("sent");
  };
  return { seen, fetch: wrapFetchWithBetaGuard(base, lookup) };
}

const request = (model) => [
  "https://api.anthropic.com/v1/messages",
  { headers: { [BETA_HEADER]: FULL }, body: JSON.stringify({ model, max_tokens: 16 }) },
];

test("drops the long-context beta and keeps the rest in order", () => {
  assert.equal(withoutLongContextBeta(FULL), TRIMMED);
  assert.equal(withoutLongContextBeta(TRIMMED), TRIMMED);
  assert.equal(withoutLongContextBeta(LONG_CONTEXT_BETA), null);
});

test("reads the model out of the outgoing body", () => {
  assert.equal(modelFromBody(JSON.stringify({ model: "claude-haiku-4-5" })), "claude-haiku-4-5");
  assert.equal(modelFromBody(Buffer.from(JSON.stringify({ model: "claude-fable-5-1" }))), "claude-fable-5-1");
  assert.equal(modelFromBody(undefined), undefined);
});

test("the window comes from the registry pi already loaded", () => {
  const lookup = makeWindowLookup(registry);
  assert.equal(lookup("claude-haiku-4-5"), 200_000);
  assert.equal(lookup("nothing-by-that-name"), undefined);
  assert.equal(makeWindowLookup({ getAll: () => { throw new Error("unreadable"); } })("claude-haiku-4-5"), undefined);
});

test("a 200K model loses the beta", async () => {
  const { seen, fetch } = capture(makeWindowLookup(registry));
  await fetch(...request("claude-haiku-4-5"));
  assert.equal(seen[0], TRIMMED);
});

test("a million-token model keeps it", async () => {
  const { seen, fetch } = capture(makeWindowLookup(registry));
  await fetch(...request("claude-fable-5-1"));
  assert.equal(seen[0], FULL);
});

test("an unknown model is left alone rather than guessed at", async () => {
  const { seen, fetch } = capture(makeWindowLookup(registry));
  await fetch(...request("claude-from-the-future"));
  assert.equal(seen[0], FULL);
});

test("requests without the beta pass through untouched", async () => {
  const { seen, fetch } = capture(makeWindowLookup(registry));
  await fetch("https://api.openai.com/v1/responses", { headers: { authorization: "Bearer x" }, body: "{}" });
  assert.equal(seen[0], null);
});

test("modelSupportsLongContext needs a declared window", () => {
  assert.equal(modelSupportsLongContext({ contextWindow: 1_000_000 }), true);
  assert.equal(modelSupportsLongContext({ contextWindow: 999_999 }), false);
  assert.equal(modelSupportsLongContext({}), false);
});

test("installs once, and the plugin that wraps later sits outside it", () => {
  const order = [];
  const target = { fetch: () => order.push("real") };
  assert.equal(installBetaGuard(target, () => 200_000), true);
  assert.equal(installBetaGuard(target, () => 200_000), false, "second install would double-wrap");
  // claude-oauth wraps whatever fetch it finds, so ours ends up underneath and
  // sees the headers the plugin has already added.
  const guarded = target.fetch;
  target.fetch = (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set(BETA_HEADER, FULL);
    order.push("plugin");
    return guarded(input, { ...init, headers });
  };
  target.fetch("https://api.anthropic.com/v1/messages", { body: JSON.stringify({ model: "claude-haiku-4-5" }) });
  assert.deepEqual(order, ["plugin", "real"]);
});

test("the client-version patch is idempotent and rejects an unexpected upstream constant", () => {
  const patched = patchClaudeOauthSource(adapterSource);
  assert.equal(patchClaudeOauthSource(patched), patched);
  assert.throws(() => patchClaudeOauthSource("const CLAUDE_CODE_VERSION = \"9.0.0\";"), /review the upstream/);
});

test("the released Claude adapter preserves Pi capabilities and advertises at least Claude Code 2.1.280", async () => {
  const previousFetch = globalThis.fetch;
  const sent = [];
  const handlers = new Map();
  globalThis.fetch = wrapFetchWithBetaGuard(async (_input, init) => {
    sent.push({ headers: new Headers(init.headers), body: JSON.parse(Buffer.from(init.body).toString()) });
    return new Response("{}");
  }, model => model === "claude-opus-5-5" ? 1_000_000 : 200_000);
  try {
    claudeOauth({ on: (event, handler) => handlers.set(event, handler) });
    for (const model of ["claude-opus-5-5", "claude-haiku-4-5"]) {
      const payload = {
        model, max_tokens: 128000,
        system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [
          { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
          { role: "system", content: [], output_config: { effort: "max" } },
        ],
        thinking: { type: "adaptive" },
      };
      const rewritten = handlers.get("before_provider_request")({ payload });
      await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", body: JSON.stringify(rewritten),
        headers: { "anthropic-beta": "mid-conversation-output-config-2026-07-01" },
      });
    }
    for (const { headers, body } of sent) {
      const version = headers.get("user-agent").match(/^claude-cli\/(\d+)\.(\d+)\.(\d+)/);
      assert.ok(version);
      const [major, minor, patch] = version.slice(1).map(Number);
      assert.ok(major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 280));
      assert.ok(body.system[0].text.includes(`cc_version=${version.slice(1).join(".")}.`));
      assert.doesNotMatch(body.system[0].text, /cch=00000/);
      assert.equal(body.max_tokens, 128000);
      assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" });
      assert.deepEqual(body.messages[1], { role: "system", content: [], output_config: { effort: "max" } });
      assert.ok(headers.get(BETA_HEADER).includes("mid-conversation-output-config-2026-07-01"));
    }
    assert.ok(sent[0].headers.get(BETA_HEADER).includes(LONG_CONTEXT_BETA));
    assert.ok(!sent[1].headers.get(BETA_HEADER).includes(LONG_CONTEXT_BETA));
  } finally { globalThis.fetch = previousFetch; }
});
