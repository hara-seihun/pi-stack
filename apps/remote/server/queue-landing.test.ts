import { expect, test } from "bun:test";
import { LandedWork, landedWorkIds } from "./queue-landing";

const context = { messages: [
  { role: "user", content: "First ask" },
  { role: "assistant", content: [{ type: "text", text: "Second ask" }] },
  { role: "user", content: [{ type: "text", text: "Actually, stop and do this instead\n\nThe following files were attached" }] },
  { role: "user", content: "<agent_message>\n{\"senderThreadId\":\"child\",\"messageId\":\"thread-result:exec-1\"}\n\n{\"type\":\"thread_idle\"}\n</agent_message>" },
] };

test("a steer lands once its text or agent-message id appears as a user message", () => {
  const landed = landedWorkIds(context, [
    { id: "a", text: "First ask" },
    { id: "b", text: "Second ask" },
    { id: "c", text: "Actually, stop and do this instead" },
    { id: "thread-result:exec-1", text: "{\"type\":\"thread_idle\",\"threadId\":\"child\"}" },
    { id: "d", text: "" },
  ]);
  expect([...landed].sort()).toEqual(["a", "c", "thread-result:exec-1"]);
  expect(landedWorkIds({}, [{ id: "a", text: "x" }]).size).toBe(0);
});

test("a patched context lands its messages, and is read only while one is waiting", () => {
  const landed = new LandedWork();
  let reads = 0;
  const read = () => { reads++; return context; };

  landed.mark("session", [], read);
  expect(reads).toBe(0);

  landed.mark("session", [{ id: "a", text: "First ask" }], read);
  expect(landed.has("session", "a")).toBe(true);
  expect(reads).toBe(1);

  // The next patch arrives with nothing new waiting: no parse, same answer.
  landed.mark("session", [{ id: "a", text: "First ask" }], read);
  expect(reads).toBe(1);

  landed.mark("session", [{ id: "a", text: "First ask" }, { id: "b", text: "Not there yet" }], read);
  expect(reads).toBe(2);
  expect(landed.has("session", "b")).toBe(false);
  expect(landed.has("other", "a")).toBe(false);

  landed.forget("session");
  expect(landed.has("session", "a")).toBe(false);
});
