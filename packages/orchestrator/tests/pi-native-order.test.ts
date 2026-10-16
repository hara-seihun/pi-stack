import { expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiInputBatch } from "../src/threads/pi-input-batch.js";
import { PiExecution } from "../src/threads/pi-execution.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it("upstream Pi closes each call once and starts the next model request while the held operation survives", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-order-"));
  let inbox: PiInputBatch | undefined;
  const held = gate(), heldStarted = gate(), fastObserved = gate(), secondRequest = gate(), completed = gate();
  const requests: any[][] = [], endings: any[] = [];
  try {
    const file = join(root, "native.jsonl"); seedPiSession(file, root); const manager = SessionManager.open(file);
    const agent = new Agent({ initialState: {
      model: { id: "fixture", provider: "fixture", api: "openai-responses" } as any,
      tools: ["fast", "held"].map(name => ({ name, label: name, description: name, parameters: { type: "object", properties: {} },
        execute: async () => { if (name === "held") { heldStarted.resolve(); await held.promise; } return { content: [{ type: "text" as const, text: `${name} result` }], details: {} }; } })),
    }, toolExecution: "parallel", steeringMode: "all",
      convertToLlm: messages => messages.map(message => message.role === "custom" ? { role: "user", content: message.content, timestamp: message.timestamp } : message) as any,
      streamFn: (_model, context) => {
        requests.push([...context.messages]);
        const initial = requests.length === 1;
        if (!initial) secondRequest.resolve();
        const message: any = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", timestamp: Date.now(), stopReason: initial ? "toolUse" : "stop",
          content: initial ? [{ type: "text", text: "entire finalized output" }, ...["fast", "held"].map(name => ({ type: "toolCall", id: name, name, arguments: {} }))] : [{ type: "text", text: "next output" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
        return stream;
      },
    });
    agent.subscribe(event => {
      if (event.type === "message_end") {
        if (event.message.role === "custom") manager.appendCustomMessageEntry(event.message.customType, event.message.content, true, event.message.details);
        else manager.appendMessage(event.message as any);
      }
      if (event.type === "tool_execution_end") { endings.push(event); if (event.toolCallId === "fast") fastObserved.resolve(); }
    });
    let run: Promise<void> | undefined;
    const session = { agent, sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: file,
      get messages() { return agent.state.messages; }, get isIdle() { return !agent.state.isStreaming; }, get isStreaming() { return agent.state.isStreaming; },
      subscribe: () => () => {}, sendCustomMessage: (message: any) => {
        const custom = { ...message, role: "custom", timestamp: Date.now() };
        if (agent.state.isStreaming) { agent.steer(custom); return Promise.resolve(); }
        run = agent.prompt(custom); return run;
      },
    } as unknown as AgentSession;
    const execution = new PiExecution(() => {}, () => completed.resolve()); execution.bind(session);
    inbox = new PiInputBatch(session, execution, () => {}, () => {});
    inbox.accept([{ workId: "initial", message: "start" }]);
    await Promise.all([heldStarted.promise, fastObserved.promise]);
    inbox.accept([{ workId: "human", message: "human input", inputOrigin: "human" }, { workId: "agent", message: "agent input", inputOrigin: "machine" }]);
    await secondRequest.promise;
    expect(execution.activeTools).toBe(1);
    const next = requests[1]!;
    const assistantIndex = next.findIndex(message => message.role === "assistant");
    const results = next.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.find(message => message.toolCallId === "fast").content[0].text).toBe("fast result");
    expect(results.find(message => message.toolCallId === "held").details).toMatchObject({ state: "running" });
    expect(next[assistantIndex].content[0].text).toBe("entire finalized output");
    expect(next.slice(assistantIndex + 1, assistantIndex + 3).map(message => message.role)).toEqual(["toolResult", "toolResult"]);
    expect(JSON.stringify(next[assistantIndex + 3].content)).toContain("human input");
    expect(JSON.stringify(next[assistantIndex + 3].content)).toContain("agent input");
    await run;
    held.resolve(); await completed.promise;
    expect(endings).toHaveLength(2);
  } finally { held.resolve(); inbox?.close(); rmSync(root, { recursive: true, force: true }); }
});
