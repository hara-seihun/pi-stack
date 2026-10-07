import { expect, it } from "vitest";
import { modeEnvironment, modeTools } from "../src/threads/pi-mode.js";

function session(names: string[]) {
  let active = [...names];
  const handlers: Array<() => void> = [];
  const pi = {
    on: (event: string, handler: () => void) => { if (event === "before_agent_start") handlers.push(handler); },
    getAllTools: () => names.map(name => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => { active = next; },
  };
  return { pi, turn: () => handlers.forEach(handler => handler()), active: () => active };
}

it("applies an explicit live dispatcher tool profile independently of peer spawning", () => {
  const tools = ["bash", "read", "edit", "write", "web_search", "agent_browser", "thread_spawn", "thread_await", "meet_voice"];
  const conversation = session(tools);
  const env: NodeJS.ProcessEnv = { PI_THREAD_MODE: "live", PI_THREAD_CAN_SPAWN: "1", PI_THREAD_LIVE_DISPATCHER: "1", PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS: "1800" };
  modeEnvironment(env);
  modeTools(env)(conversation.pi as never);
  conversation.turn();
  expect(conversation.active()).toEqual(["bash", "read", "thread_spawn", "meet_voice"]);
  expect(env.PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS).toBe("10");

  const worker = session(tools);
  const workerEnv: NodeJS.ProcessEnv = { PI_THREAD_MODE: "live", PI_THREAD_CAN_SPAWN: "1", PI_THREAD_LIVE_DISPATCHER: "0", PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS: "1800" };
  modeEnvironment(workerEnv);
  modeTools(workerEnv)(worker.pi as never);
  worker.turn();
  expect(worker.active()).toEqual(tools);
  expect(workerEnv.PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS).toBe("1800");
});
