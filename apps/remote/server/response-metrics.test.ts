import { describe, expect, test } from "bun:test";
import { displayContextMessage } from "./context-display";
import { messageFinalizationKey } from "./sync";
import { deriveTranscriptItems } from "./transcript-items";
import { isResponseMetrics, outputUsageOf, ResponseTiming } from "./response-metrics";

function timing(): { clock: { now: number }; tracker: ResponseTiming } {
  const clock = { now: 1_000 };
  return { clock, tracker: new ResponseTiming(() => clock.now) };
}

const assistant = (metrics?: unknown) => ({
  role: "assistant", timestamp: 7, content: [{ type: "text", text: "done" }],
  ...(metrics ? { responseMetrics: metrics } : {}),
});

describe("response timing", () => {
  test("uses the time Pi produced each event, not a burst of late arrivals", () => {
    const { clock, tracker } = timing();
    // A whole 300-token response reaches the supervisor within 200 ms.
    clock.now = 50_000; tracker.start("session", 40_000);
    clock.now = 50_001; tracker.firstToken("session", 41_000);
    clock.now = 50_200;
    const metrics = tracker.finish("session", { usage: { output: 300 } }, 45_000);
    expect(metrics).toEqual({ ttftMs: 1_000, generationMs: 4_000, outputTokens: 300, tokensPerSecond: 75 });
  });

  test("measures the wait for the first token and the streaming that followed", () => {
    const { clock, tracker } = timing();
    tracker.start("session");
    clock.now += 1_400;
    tracker.firstToken("session");
    clock.now += 100;
    tracker.firstToken("session"); // later deltas do not move the measurement
    clock.now += 1_900;
    const metrics = tracker.finish("session", { usage: { output: 120 } });
    expect(metrics).toEqual({ ttftMs: 1_400, generationMs: 2_000, outputTokens: 120, tokensPerSecond: 60 });
    expect(isResponseMetrics(metrics)).toBe(true);
  });

  test("a reasoning response counts its hidden tokens against the whole response", () => {
    const { clock, tracker } = timing();
    tracker.start("session");
    clock.now += 14_000; // thinking nobody sees
    tracker.firstToken("session");
    clock.now += 1_000; // two lines of answer
    const metrics = tracker.finish("session", { usage: { output: 1_500, reasoning: 1_400 } });
    // The visible stream alone would claim 1,500 tokens per second.
    expect(metrics).toEqual({ ttftMs: 14_000, generationMs: 1_000, outputTokens: 1_500, tokensPerSecond: 100 });
  });

  test("a response that never streamed a token is not measured", () => {
    const { clock, tracker } = timing();
    tracker.start("session");
    clock.now += 500;
    expect(tracker.finish("session", { usage: { output: 10 } })).toBeNull();
    expect(tracker.finish("session", { usage: { output: 10 } })).toBeNull();
  });

  test("a retry replaces the response in flight, and a settled thread drops it", () => {
    const { clock, tracker } = timing();
    tracker.start("session");
    clock.now += 5_000;
    tracker.start("session");
    clock.now += 200;
    tracker.firstToken("session");
    clock.now += 1_000;
    expect(tracker.finish("session", { usage: { output: 50 } })).toMatchObject({ ttftMs: 200, tokensPerSecond: 50 });
    tracker.start("session");
    tracker.forget("session");
    expect(tracker.finish("session", { usage: { output: 50 } })).toBeNull();
  });

  test("tokens per second stays out of it without usage or a long enough stream", () => {
    const { clock, tracker } = timing();
    tracker.start("session");
    clock.now += 300;
    tracker.firstToken("session");
    clock.now += 40;
    expect(tracker.finish("session", { usage: { output: 4 } })).toEqual({
      ttftMs: 300, generationMs: 40, outputTokens: 4, tokensPerSecond: null,
    });
    expect(outputUsageOf({ usage: { output: "many", reasoning: -3 } })).toEqual({ output: 0, reasoning: 0 });
    expect(outputUsageOf(null)).toEqual({ output: 0, reasoning: 0 });
    expect(isResponseMetrics({ ttftMs: 1, generationMs: 1, outputTokens: 1 })).toBe(false);
  });
});

describe("delivery to the transcript", () => {
  test("the display projection carries the measurement of the message it belongs to", () => {
    const message = { role: "assistant", timestamp: 7, model: "sol", usage: { output: 3 },
      content: [{ type: "text", text: "done" }] };
    const metrics = { ttftMs: 900, generationMs: 1_000, outputTokens: 30, tokensPerSecond: 30 };
    const projected = displayContextMessage(message, undefined, metrics);
    expect(projected).toEqual({ role: "assistant", timestamp: 7, responseMetrics: metrics,
      content: [{ type: "text", text: "done" }] });
  });

  test("the last item an assistant message produced carries it", () => {
    const metrics = { ttftMs: 900, generationMs: 1_000, outputTokens: 30, tokensPerSecond: 30 };
    const text = deriveTranscriptItems({ messages: [assistant(metrics)] });
    expect(text.at(-1)!.head).toMatchObject({ kind: "assistant", responseMetrics: metrics });

    const toolsOnly = deriveTranscriptItems({ messages: [{
      role: "assistant", timestamp: 8, responseMetrics: metrics,
      content: [{ type: "toolCall", id: "a", name: "Bash", arguments: {} }, { type: "toolCall", id: "b", name: "Bash", arguments: {} }],
    }] });
    expect(toolsOnly.map(item => item.head.kind)).toEqual(["system", "toolCall", "toolCall"]);
    expect(toolsOnly.at(-1)!.head.responseMetrics).toEqual(metrics);
    expect(toolsOnly[1].head.responseMetrics).toBeUndefined();

    expect(deriveTranscriptItems({ messages: [assistant({ ttftMs: 1 })] }).at(-1)!.head.responseMetrics).toBeUndefined();
  });

});
