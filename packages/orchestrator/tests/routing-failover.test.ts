import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Ledger } from "../src/ledger/ledger.js";

/** A pi harness thin enough to drive the real extension: it records the
 * calls routing makes and replays the event order pi itself uses. */
function harness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const sent: string[] = [];
  const ctx = { model: undefined as Model<never> | undefined } as unknown as ExtensionContext;
  const pi = {
    registerProvider: () => {},
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
      handlers.set(event, handler);
    },
    setModel: async (model: Model<never>) => {
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
  return { pi, ctx, sent, emit };
}

/** Only the fields routing reads; pi's own message type is not exported. */
interface AssistantMessage {
  role: "assistant";
  content: unknown[];
  stopReason?: string;
  errorMessage?: string;
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
    delete process.env.PI_ORCHESTRATOR_ASSIGNED;
    const ledger = Ledger.open(process.env.PI_ORCHESTRATOR_LEDGER);
    ledger.upsertAccount({ id: "anthropic", provider: "anthropic" });
    ledger.upsertAccount({ id: "anthropic-3", provider: "anthropic" });
    ledger.close();
  });

  afterEach(() => {
    delete process.env.PI_ORCHESTRATOR_LEDGER;
    rmSync(dir, { recursive: true, force: true });
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
    expect(sent[0]).toContain("Provider failover");
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
