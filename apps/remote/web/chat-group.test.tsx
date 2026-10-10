import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { bubbleGroups } from "./src/features/conversation/chat-group";
import { ChatMessage } from "./src/chat-message";
import { monoMessage } from "./src/app/mono";
import { presentAgentMessage } from "./src/features/conversation/agent-message";
import type { ContextEntry } from "./src/types";

const start = new Date(2026, 9, 9, 12).getTime();
function message(key: string, kind: "user" | "assistant", time: number | undefined): ContextEntry {
  return { key, signature: key, kind, messageTimestamp: time, text: key };
}

test("same-side groups stop at sender, five-minute gap and local day boundaries", () => {
  const entries = [message("a", "user", start), message("b", "user", start + 30_000), message("c", "assistant", start + 31_000), message("d", "assistant", start + 400_000), message("e", "assistant", start + 86_400_000)];
  const groups = bubbleGroups(entries);
  expect(groups.get("a")).toMatchObject({ starts: true, ends: false });
  expect(groups.get("a")?.day).toBeDefined();
  expect(groups.get("a")?.timestamp).toBeUndefined();
  expect(groups.get("b")).toEqual({ starts: false, ends: true, timestamp: start + 30_000 });
  expect(groups.get("c")).toMatchObject({ starts: true, ends: true });
  expect(groups.get("d")?.day).toBeUndefined();
  expect(groups.get("e")?.day).toBeDefined();
  expect([...groups.keys()]).toEqual(entries.map(entry => entry.key));
});

test("missing timestamps never manufacture dates or join otherwise identical messages", () => {
  expect([...bubbleGroups([message("a", "assistant", undefined), message("b", "assistant", undefined)]).values()]).toEqual([{ starts: true, ends: true }, { starts: true, ends: true }]);
});

test("bubble content keeps Markdown and accessible sender but no repeating name or timestamp header", () => {
  const html = renderToStaticMarkup(<ChatMessage kind="assistant" label="Kenan" appearance="bubble" timestamp={start} text="text" contentFormat="markdown" renderMarkdown={() => <><pre><code>line</code></pre><table><tbody><tr><td>cell</td></tr></tbody></table><img src="/picture.png" alt="picture" /></>} />);
  expect(html).toContain('aria-label="Message from Kenan"');
  expect(html).toContain('chat-bubble');
  expect(html).not.toContain('message-header');
  expect(html).not.toContain('message-label');
  expect(html).not.toContain('<time');
  expect(html).toContain('<pre>'); expect(html).toContain('<table>'); expect(html).toContain('alt="picture"');
});

test("trusted machine input is never a person bubble, including plain-text notices", () => {
  expect(monoMessage({ kind: "user", inputOrigin: "machine", text: "A worker settled" })).toBe(false);
  const human = { ...message("human", "user", start), inputOrigin: "human" as const, text: '<agent_message>literal documentation</agent_message>' };
  expect(monoMessage(human)).toBe(true);
  expect(presentAgentMessage(human)).toBe(human);
});
