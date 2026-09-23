import { expect, test } from "bun:test";
import { listenForFileDrops } from "./src/file-drop";

test("window file drops attach once to the current target, leave text drags alone, and clean up", () => {
  const target = new EventTarget();
  let session: string | null = "first";
  let visible = false;
  const received: { session: string | null; files: File[] }[] = [];
  const dispose = listenForFileDrops(target as Window, () => !!session,
    (files) => received.push({ session, files }), (value) => { visible = value; });
  const file = new File(["hello"], "hello.txt");
  const dispatch = (type: string, files = true) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: files ? ["Files"] : ["text/plain"], files: files ? [file] : [], dropEffect: "" } });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(dispatch("dragover", false)).toBe(false);
  dispatch("dragenter"); dispatch("dragenter"); dispatch("dragleave");
  expect(visible).toBe(true);
  session = "second";
  expect(dispatch("drop")).toBe(true);
  expect(received).toEqual([{ session: "second", files: [file] }]);
  expect(visible).toBe(false);
  session = null;
  expect(dispatch("drop")).toBe(true);
  expect(received).toHaveLength(1);
  session = "third";
  dispatch("dragenter"); target.dispatchEvent(new Event("blur"));
  expect(visible).toBe(false);
  dispose();
  expect(dispatch("drop")).toBe(false);
  expect(received).toHaveLength(1);
});
