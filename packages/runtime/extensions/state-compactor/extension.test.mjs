import test from "node:test";
import assert from "node:assert/strict";
import stateCompactor, {
  COMPACT_THRESHOLD_TOKENS,
  COMPACTION_MODEL,
  COMPACTION_PROVIDER,
  CONTINUATION_MESSAGE,
  RETAINED_SKILLS_TYPE,
  compactionPrompt,
  retainedSkillContext,
} from "./index.mjs";

const skill = {
  name: "math-research",
  description: "Load for mathematics",
  filePath: "/skills/math-research/SKILL.md",
};

function readCall(id, path, args = {}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: { path, ...args } }],
    },
  };
}

function readResult(id, text, timestamp = 10) {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], timestamp },
  };
}

const compacted = { type: "compaction", id: "compact", summary: "summary", firstKeptEntryId: "later" };

function text(message) {
  return message.content[0].text;
}

test("guards provider requests with one native compaction at 250,000 tokens", () => {
  const handlers = new Map();
  const messages = [];
  stateCompactor({
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  });

  assert.deepEqual([...handlers.keys()], [
    "before_agent_start",
    "context",
    "session_before_compact",
    "before_provider_request",
  ]);

  let tokens = null;
  const compactions = [];
  const ctx = {
    getContextUsage: () => ({ tokens }),
    compact: (options) => compactions.push(options),
  };
  const guard = handlers.get("before_provider_request");

  guard({}, ctx);
  tokens = COMPACT_THRESHOLD_TOKENS - 1;
  guard({}, ctx);
  assert.equal(compactions.length, 0);

  tokens = COMPACT_THRESHOLD_TOKENS;
  guard({}, ctx);
  guard({}, ctx);
  assert.equal(compactions.length, 1);

  compactions[0].onError(new Error("failed"));
  assert.equal(messages.length, 0);
  guard({}, ctx);
  assert.equal(compactions.length, 2);

  compactions[1].onComplete({});
  assert.deepEqual(messages, [
    {
      message: {
        customType: "state-compactor",
        content: CONTINUATION_MESSAGE,
        display: false,
      },
      options: { triggerTurn: true },
    },
  ]);
});

test("routes Anthropic compaction through the independent OpenAI summarizer", async () => {
  const handlers = new Map();
  let request;
  const model = { provider: COMPACTION_PROVIDER, id: COMPACTION_MODEL };
  const usage = { totalTokens: 100 };
  stateCompactor({
    on: (event, handler) => handlers.set(event, handler),
    sendMessage() {},
  });
  const preparation = {
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Fix the broken thread" }] }],
    turnPrefixMessages: [],
    previousSummary: "Earlier work",
    firstKeptEntryId: "kept",
    tokensBefore: 251_000,
  };
  const result = await handlers.get("session_before_compact")(
    { preparation, signal: new AbortController().signal },
    {
      model: { provider: "anthropic-3" },
      modelRegistry: {
        find: (provider, modelId) => {
          assert.equal(provider, COMPACTION_PROVIDER);
          assert.equal(modelId, COMPACTION_MODEL);
          return model;
        },
        complete: async (...args) => {
          request = args;
          return { content: [{ type: "text", text: "  compacted work  " }], usage };
        },
      },
    },
  );
  assert.equal(request[0], model);
  assert.match(request[1].messages[0].content[0].text, /Fix the broken thread/);
  assert.match(request[1].messages[0].content[0].text, /Earlier work/);
  assert.equal(request[2].cacheRetention, "none");
  assert.deepEqual(result, {
    compaction: {
      summary: "compacted work",
      firstKeptEntryId: "kept",
      tokensBefore: 251_000,
      usage,
    },
  });
});

test("leaves non-Anthropic compaction on its current provider", async () => {
  const handlers = new Map();
  stateCompactor({ on: (event, handler) => handlers.set(event, handler), sendMessage() {} });
  const result = await handlers.get("session_before_compact")(
    { preparation: {}, signal: new AbortController().signal },
    { model: { provider: "openai-codex" } },
  );
  assert.equal(result, undefined);
});

test("compaction prompt preserves split-turn and previous-summary context", () => {
  const prompt = compactionPrompt({
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "history" }] }],
    turnPrefixMessages: [{ role: "assistant", content: [{ type: "text", text: "turn prefix" }] }],
    previousSummary: "previous",
  });
  assert.match(prompt, /history/);
  assert.match(prompt, /turn prefix/);
  assert.match(prompt, /<previous-summary>\nprevious/);
});

test("restores every fully loaded skill after compaction", () => {
  const retained = retainedSkillContext({
    branch: [readCall("read", skill.filePath), readResult("read", "one\ntwo\nthree"), compacted],
    skills: [skill],
    cwd: "/work",
    readCurrent: () => "one\ntwo\nthree",
  });
  assert.equal(retained.customType, RETAINED_SKILLS_TYPE);
  assert.match(text(retained), /Every skill below was loaded before compaction/);
  assert.match(text(retained), /one\ntwo\nthree/);
});

test("puts retained skills before compacted conversation messages", () => {
  const handlers = new Map();
  stateCompactor({ on: (event, handler) => handlers.set(event, handler), sendMessage() {} });
  handlers.get("before_agent_start")({ systemPromptOptions: { skills: [skill] } });
  const branch = [readCall("read", skill.filePath), readResult("read", "one\ntwo"), compacted];
  const result = handlers.get("context")(
    { messages: [{ role: "summary", summary: "compacted work" }, { role: "user", content: "continue" }] },
    {
      cwd: "/work",
      sessionManager: { getBranch: () => branch },
    },
  );
  assert.equal(result.messages[0].customType, RETAINED_SKILLS_TYPE);
  assert.equal(result.messages[1].summary, "compacted work");
});

test("combines paged reads and asks for a missing page", () => {
  const pageOne = "one\ntwo\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]";
  const partial = retainedSkillContext({
    branch: [readCall("p1", skill.filePath, { limit: 2 }), readResult("p1", pageOne), compacted],
    skills: [skill],
    cwd: "/work",
    readCurrent: () => "one\ntwo\nthree",
  });
  assert.match(text(partial), /offset=3/);

  const complete = retainedSkillContext({
    branch: [
      readCall("p1", skill.filePath, { limit: 2 }),
      readResult("p1", pageOne),
      compacted,
      readCall("p2", skill.filePath, { offset: 3 }),
      readResult("p2", "three", 20),
    ],
    skills: [skill],
    cwd: "/work",
    readCurrent: () => "one\ntwo\nthree",
  });
  assert.match(text(complete), /one\ntwo\nthree/);
  assert.doesNotMatch(text(complete), /refresh required/);
});

test("requests a reread when a loaded skill changed", () => {
  const retained = retainedSkillContext({
    branch: [readCall("read", skill.filePath), readResult("read", "old"), compacted],
    skills: [skill],
    cwd: "/work",
    readCurrent: () => "new",
  });
  assert.match(text(retained), /reread/);
  assert.match(text(retained), /changed/);
});

test("does not duplicate a skill loaded only after the latest compaction", () => {
  const retained = retainedSkillContext({
    branch: [compacted, readCall("read", skill.filePath), readResult("read", "one")],
    skills: [skill],
    cwd: "/work",
    readCurrent: () => "one",
  });
  assert.equal(retained, null);
});
