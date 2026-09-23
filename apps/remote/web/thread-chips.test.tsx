import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadChips, ThreadDirectoryProvider, threadIdsOf, type ThreadDirectory } from "./src/features/conversation/thread-chips";

const first = "7c925d87-bc2b-4293-933a-f9ffee9b3592";
const second = "303efcde-ee6c-43f5-b3ed-522aa9f34ca4";

test("a thread tool call names the threads it is about", () => {
  expect(threadIdsOf("thread_await", { threadIds: [first, second, first] })).toEqual([first, second]);
  expect(threadIdsOf("functions.thread_send", { threadId: second, text: "hello" })).toEqual([second]);
  expect(threadIdsOf("thread_await", { threadIds: [first], threadId: second })).toEqual([second, first]);
  expect(threadIdsOf("bash", { command: first })).toEqual([]);
  expect(threadIdsOf("thread_read", { threadId: "Toy2 Optimality" })).toEqual([]);
  expect(threadIdsOf("thread_spawn", {})).toEqual([]);
});

test("known threads show their name and running threads are marked", () => {
  const asked: string[][] = [];
  const directory: ThreadDirectory = {
    name: id => id === first ? "Toy2 Optimality" : null,
    busy: id => id === first,
    open: () => {},
    discover: ids => asked.push(ids),
  };
  const html = renderToStaticMarkup(<ThreadDirectoryProvider value={directory}>
    <ThreadChips ids={[first, second]} />
  </ThreadDirectoryProvider>);
  expect(html).toContain("Toy2 Optimality");
  expect(html).toContain("thread-chip busy");
  expect(html).toContain(`Thread ${second.slice(0, 8)}`);
  expect(renderToStaticMarkup(<ThreadChips ids={[first]} />)).toBe("");
});
