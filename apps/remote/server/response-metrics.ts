// How fast a model response arrived. Pi tells the supervisor when an assistant
// message starts, streams its text and thinking deltas, and ends with the
// provider's usage. That is everything two familiar numbers need: the wait
// before the first token, and the output tokens per second that followed.
//
// A reasoning model spends most of a response on tokens nobody sees. They are
// in the provider's output count, so their rate is measured over the whole
// response rather than over the visible stream.
//
// Timing is observed live, so it belongs to the supervisor rather than to the
// model context. A finished measurement is stored as a durable `metrics` event
// keyed by the message it finalizes, the same join the streamed thinking uses,
// and reaches the client on the transcript item that message produced.

import type { ResponseMetrics } from "./protocol";

export type { ResponseMetrics };

/** A response whose first token has not arrived yet. */
interface PendingResponse {
  startedAt: number;
  firstTokenAt: number | null;
}

export function responseMetrics(response: PendingResponse, endedAt: number, usage: OutputUsage): ResponseMetrics | null {
  if (response.firstTokenAt === null) return null;
  const ttftMs = Math.max(0, response.firstTokenAt - response.startedAt);
  const generationMs = Math.max(0, endedAt - response.firstTokenAt);
  // Reasoning tokens are charged to this response but are mostly produced
  // before the first visible token, so the streaming window is the wrong
  // denominator for them: a long think with a two-line answer used to report
  // hundreds of tokens per second. A response with reasoning is measured over
  // its whole duration; one without keeps the streaming window, where the wait
  // is prompt processing rather than generation.
  const rateMs = usage.reasoning > 0 ? Math.max(0, endedAt - response.startedAt) : generationMs;
  const tokensPerSecond = rateMs >= 100 && usage.output > 0
    ? Math.round(usage.output / (rateMs / 1_000) * 10) / 10
    : null;
  return { ttftMs, generationMs, outputTokens: usage.output, tokensPerSecond };
}

/** What a provider says it generated. Pi counts reasoning inside `output` and
 * breaks it out separately; a provider that reports neither leaves the token
 * half of the readout out. */
export interface OutputUsage { output: number; reasoning: number }

function count(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function outputUsageOf(message: unknown): OutputUsage {
  const usage = (message as { usage?: Record<string, unknown> } | null)?.usage;
  return { output: count(usage?.output), reasoning: count(usage?.reasoning) };
}

export function isResponseMetrics(value: unknown): value is ResponseMetrics {
  const metrics = value as ResponseMetrics | null;
  return !!metrics && typeof metrics === "object"
    && Number.isFinite(metrics.ttftMs) && Number.isFinite(metrics.generationMs)
    && Number.isFinite(metrics.outputTokens)
    && (metrics.tokensPerSecond === null || Number.isFinite(metrics.tokensPerSecond));
}

/**
 * One in-flight response per session. `message_start` opens it, the first text
 * or thinking delta closes the first-token wait, and `message_end` finishes the
 * measurement. A provider that replies without streaming, an aborted turn and a
 * message the supervisor only learns about from a context capture all produce
 * no measurement rather than a made-up one.
 */
export class ResponseTiming {
  private readonly pending = new Map<string, PendingResponse>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** A retry or a new assistant message replaces whatever was in flight. */
  start(sessionId: string): void {
    this.pending.set(sessionId, { startedAt: this.clock(), firstTokenAt: null });
  }

  /** The first visible token of the current response. Later deltas are ignored. */
  firstToken(sessionId: string): void {
    const response = this.pending.get(sessionId);
    if (response && response.firstTokenAt === null) response.firstTokenAt = this.clock();
  }

  finish(sessionId: string, message: unknown): ResponseMetrics | null {
    const response = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    if (!response) return null;
    return responseMetrics(response, this.clock(), outputUsageOf(message));
  }

  forget(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
