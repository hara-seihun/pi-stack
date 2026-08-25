import type { Model, Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Ledger } from "../ledger/ledger.js";
import {
  delegatedSessionManager,
  openHostedSession,
  type HostedSessionOptions,
} from "./session-lifecycle.js";

export interface DelegateInput {
  readonly task: string;
  readonly cwd?: string;
}

export interface DelegateParent {
  readonly cwd: string;
  readonly model: Model<any>;
  readonly thinkingLevel: string | undefined;
  readonly tools: readonly string[];
  readonly sessionId: string;
}

export interface DelegateAnswer {
  readonly text: string;
  readonly sessionId: string;
  readonly usage?: Usage;
}

interface QueueWaiter {
  readonly ready: Promise<void>;
  release(): void;
}

function gate(): QueueWaiter {
  let release!: () => void;
  return { ready: new Promise<void>((resolveReady) => (release = resolveReady)), release };
}

/** One queue belongs to one parent extension instance. Parallel tool calls
 * wait their turn instead of multiplying the account reservation. */
export class Delegator {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ledger: Ledger,
    private readonly options: Pick<HostedSessionOptions, "agentDir" | "openSession"> = {},
  ) {}

  async run(input: DelegateInput, parent: DelegateParent, signal?: AbortSignal): Promise<DelegateAnswer> {
    const previous = this.tail;
    const next = gate();
    this.tail = previous.catch(() => {}).then(() => next.ready);
    try {
      await abortable(previous, signal);
      return await this.runNow(input, parent, signal);
    } finally {
      next.release();
    }
  }

  private async runNow(
    input: DelegateInput,
    parent: DelegateParent,
    signal?: AbortSignal,
  ): Promise<DelegateAnswer> {
    const task = input.task.trim();
    if (task === "") throw new Error("delegate task cannot be empty");
    const cwd = input.cwd === undefined ? parent.cwd : resolve(parent.cwd, input.cwd);
    signal?.throwIfAborted();
    const hosted = await openHostedSession({
      ...this.options,
      cwd,
      model: parent.model,
      thinkingLevel: parent.thinkingLevel,
      tools: [...parent.tools],
      sessionManager: delegatedSessionManager(cwd),
      parentSessionId: parent.sessionId,
    });
    this.ledger.linkNestedSession(parent.sessionId, hosted.sessionId);

    const abort = (): void => {
      void hosted.session.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await abortable(hosted.session.prompt(task), signal, abort);
      const last = lastAssistant(hosted.session);
      if (last?.stopReason === "aborted" || signal?.aborted) {
        throw new Error("delegated session cancelled");
      }
      if (last?.stopReason === "error") {
        throw new Error(last.errorMessage ?? "delegated session failed");
      }
      const text = assistantText(last);
      if (text === "") throw new Error("delegated session returned no final answer");
      return { text: boundedAnswer(text), sessionId: hosted.sessionId, usage: sessionUsage(hosted.session) };
    } finally {
      signal?.removeEventListener("abort", abort);
      hosted.dispose();
    }
  }
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(new Error("delegated session cancelled"));
  }
  return new Promise<T>((resolvePromise, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(new Error("delegated session cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function lastAssistant(
  session: AgentSession,
): ({ role: "assistant"; content?: unknown; stopReason?: string; errorMessage?: string } & Record<string, any>) | undefined {
  return [...session.messages].reverse().find((message) => message.role === "assistant") as never;
}

function assistantText(message: { content?: unknown } | undefined): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("")
    .trim();
}

/** Tool output follows Pi's 50KB context boundary. */
function boundedAnswer(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= 50 * 1024) return text;
  let end = Math.min(text.length, 50 * 1024);
  while (Buffer.byteLength(text.slice(0, end)) > 50 * 1024) end -= 256;
  return `${text.slice(0, end)}\n\n[Delegated answer truncated from ${bytes} bytes.]`;
}

function sessionUsage(session: AgentSession): Usage | undefined {
  const usages = session.messages
    .filter((message: any) => message.role === "assistant" && message.usage)
    .map((message: any) => message.usage as Usage);
  if (usages.length === 0) return undefined;
  const sum = (pick: (usage: Usage) => number): number => usages.reduce((total, usage) => total + pick(usage), 0);
  const hasReasoning = usages.some((usage) => usage.reasoning !== undefined);
  const hasCacheWrite1h = usages.some((usage) => usage.cacheWrite1h !== undefined);
  return {
    input: sum((usage) => usage.input),
    output: sum((usage) => usage.output),
    cacheRead: sum((usage) => usage.cacheRead),
    cacheWrite: sum((usage) => usage.cacheWrite),
    totalTokens: sum((usage) => usage.totalTokens),
    ...(hasReasoning ? { reasoning: sum((usage) => usage.reasoning ?? 0) } : {}),
    ...(hasCacheWrite1h ? { cacheWrite1h: sum((usage) => usage.cacheWrite1h ?? 0) } : {}),
    cost: {
      input: sum((usage) => usage.cost.input),
      output: sum((usage) => usage.cost.output),
      cacheRead: sum((usage) => usage.cost.cacheRead),
      cacheWrite: sum((usage) => usage.cost.cacheWrite),
      total: sum((usage) => usage.cost.total),
    },
  };
}
