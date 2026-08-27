import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Ledger } from "../src/ledger/ledger.js";

/** Only the fields routing reads; pi's own message type is not exported. */
interface AssistantMessage {
  role: "assistant";
  content: unknown[];
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
}

type BranchEntry =
  | { type: "model_change"; provider: string; modelId: string }
  | { type: "message"; message: AssistantMessage };

/** A pi harness thin enough to drive the real extension: it records the
 * calls routing makes and replays the event order pi itself uses. */
function harness(branch: BranchEntry[] = []) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const sent: string[] = [];
  const selected: Model<never>[] = [];
  const ctx = {
    model: undefined as Model<never> | undefined,
    cwd: "/tmp",
    thinkingLevel: "high",
    modelRegistry: { refresh: async () => ({ aborted: false, errors: new Map() }) },
    sessionManager: {
      getSessionId: () => "interactive-session",
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
  const pi = {
    registerProvider: () => {},
    registerTool: () => {},
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
      handlers.set(event, handler);
    },
    setModel: async (model: Model<never>) => {
      selected.push(model);
      (ctx as { model?: Model<never> }).model = model;
      return true;
    },
    sendUserMessage: (content: string) => {
      sent.push(content);
    },
  };
  const emit = async (event: string, payload: Record<string, unknown> = {}): Promise<void> => {
    await handlers.get(event)?.({ type: event, ...payload }, ctx);
  };
  return { pi, ctx, sent, selected, emit };
}

const assistant = (partial: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  ...partial,
});

const RATE_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed ' +
  'your account\'s rate limit. Please try again later."}}';

const errored = assistant({ stopReason: "error", errorMessage: RATE_LIMIT });
const completed = assistant({ stopReason: "stop", content: [{ type: "text", text: "done" }] });

describe("interactive failover notices", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-routing-"));
    process.env.PI_ORCHESTRATOR_LEDGER = join(dir, "ledger.sqlite3");
    process.env.PI_ORCHESTRATOR_CONFIG = join(dir, "config.json");
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: {}, "anthropic-3": {} }));
    writeFileSync(
      process.env.PI_ORCHESTRATOR_CONFIG,
      JSON.stringify({
        tiers: { light: [], standard: [{ provider: "anthropic", model: "claude-opus-5" }], expert: [] },
        providers: { anthropic: { meters: [{ id: "a-5h", drainedBy: ["default:cost"], windowHours: 5 }] } },
      }),
    );
    delete process.env.PI_ORCHESTRATOR_ASSIGNED;
    const ledger = Ledger.open(process.env.PI_ORCHESTRATOR_LEDGER);
    ledger.upsertAccount({ id: "anthropic", provider: "anthropic" });
    ledger.upsertAccount({ id: "anthropic-3", provider: "anthropic" });
    ledger.upsertAccount({ id: "openai-codex-10", provider: "openai-codex", shared: true });
    ledger.close();
  });

  afterEach(() => {
    delete process.env.PI_ORCHESTRATOR_LEDGER;
    delete process.env.PI_ORCHESTRATOR_CONFIG;
    delete process.env.PI_AGENT_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores the last explicit model after Pi falls back during process startup", async () => {
    const { pi, ctx, emit } = harness([
      { type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { type: "model_change", provider: "openai-codex-10", modelId: "gpt-5.6-sol" },
      {
        type: "message",
        message: assistant({ provider: "openai-codex-10", model: "gpt-5.6-sol" }),
      },
      {
        type: "message",
        message: assistant({ provider: "anthropic", model: "claude-opus-4-8" }),
      },
    ]);
    const routing = (await import("../src/extension/routing.js")).default;
    routing(pi as never);
    (ctx as { model?: Model<never> }).model = {
      id: "claude-opus-4-8",
      provider: "anthropic",
    } as Model<never>;

    await emit("session_start", { reason: "startup" });

    expect(ctx.model?.provider).toBe("openai-codex-10");
    expect(ctx.model?.id).toBe("gpt-5.6-sol");
  });

  it("leaves an already restored session on its bound account", async () => {
    const { pi, ctx, selected, emit } = harness([
      { type: "model_change", provider: "anthropic-3", modelId: "claude-opus-5" },
      { type: "message", message: assistant({ provider: "anthropic-3", model: "claude-opus-5" }) },
    ]);
    const routing = (await import("../src/extension/routing.js")).default;
    routing(pi as never);
    (ctx as { model?: Model<never> }).model = {
      id: "claude-opus-5",
      provider: "anthropic-3",
    } as Model<never>;

    await emit("session_start", { reason: "startup" });

    expect(selected).toEqual([]);
    expect(ctx.model?.provider).toBe("anthropic-3");
  });

  it("still binds a fresh startup to the least-used account", async () => {
    const { pi, ctx, selected, emit } = harness();
    const routing = (await import("../src/extension/routing.js")).default;
    routing(pi as never);
    (ctx as { model?: Model<never> }).model = {
      id: "claude-opus-5",
      provider: "anthropic-3",
    } as Model<never>;

    await emit("session_start", { reason: "startup" });

    expect(selected).toHaveLength(1);
    expect(ctx.model?.provider).toBe("anthropic");
  });

  /** routing() with the session already bound to `anthropic`. */
  const start = async () => {
    const { pi, ctx, sent, emit } = harness();
    const routing = (await import("../src/extension/routing.js")).default;
    routing(pi as never);
    (ctx as { model?: Model<never> }).model = {
      id: "claude-opus-5",
      provider: "anthropic",
    } as Model<never>;
    return { ctx, sent, emit };
  };

  it("moves the account before pi's auto-retry and says nothing when the retry lands", async () => {
    const { ctx, sent, emit } = await start();

    // Run 1: the 429. The move happens here so pi's own auto-retry inherits
    // the healthy account.
    await emit("agent_end", { messages: [errored] });
    expect(ctx.model?.provider).toBe("anthropic-3");
    expect(sent).toEqual([]);
    const ledger = Ledger.open(process.env.PI_ORCHESTRATOR_LEDGER as string);
    expect(ledger.accounts().find((a) => a.id === "anthropic")?.cooldownUntil).toBeGreaterThan(
      Date.now(),
    );
    ledger.close();

    // Run 2: the retry completes the turn on the new account. The agent's
    // reply is already delivered, so it must not be told the turn failed.
    await emit("agent_end", { messages: [completed] });
    await emit("agent_settled");
    expect(sent).toEqual([]);
  });

  it("tells the agent to resume only once the run settles still broken", async () => {
    const { sent, emit } = await start();
    await emit("agent_end", { messages: [errored] });
    await emit("agent_settled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Your last turn was cut off");
    expect(sent[0]).toContain("anthropic-3");
    // One notice per lost turn, never a second on a later settle.
    await emit("agent_settled");
    expect(sent).toHaveLength(1);
  });

  it("stays silent when a non-rate-limit failure ends the run", async () => {
    const { ctx, sent, emit } = await start();
    await emit("agent_end", {
      messages: [assistant({ stopReason: "error", errorMessage: "Invalid API key" })],
    });
    await emit("agent_settled");
    expect(ctx.model?.provider).toBe("anthropic");
    expect(sent).toEqual([]);
  });

  it("stays silent when no other account is available to move to", async () => {
    const ledger = Ledger.open(process.env.PI_ORCHESTRATOR_LEDGER as string);
    ledger.removeAccount("anthropic-3");
    ledger.close();
    const { ctx, sent, emit } = await start();
    await emit("agent_end", { messages: [errored] });
    await emit("agent_settled");
    expect(ctx.model?.provider).toBe("anthropic");
    expect(sent).toEqual([]);
  });
});
