import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { patchBrowserQa } from "./patch-browser-qa.mjs";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pi-agent-browser-native/package.json"));
const source = readFileSync(join(root, "dist/extensions/agent-browser/lib/input-modes/job.js"), "utf8");
const patched = patchBrowserQa(source);
const start = patched.indexOf("function buildQaVisibleTextPredicate(text) {");
const end = patched.indexOf("\nfunction qaVisibleTextWaitPassed", start);
const predicate = new Function("text", `${patched.slice(start, end)}\nreturn buildQaVisibleTextPredicate(text);`);

class Element {
  constructor(parentElement = null, display = "block", opacity = "1") {
    Object.assign(this, { parentElement, tagName: "DIV", style: { display, opacity, visibility: "visible" } });
  }
  getClientRects() { return [{}]; }
}
function includes(expected, fragments) {
  const body = new Element();
  const blocks = [new Element(body), new Element(body)];
  const nodes = fragments.map(({ text, block, inline, hidden }) => {
    let parent = block === undefined ? body : blocks[block];
    if (inline || hidden) parent = new Element(parent, "inline", hidden ? "0" : "1");
    return { nodeValue: text, parentElement: parent };
  });
  return runInNewContext(predicate(expected), {
    HTMLElement: Element, NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    window: { getComputedStyle: (element) => element.style },
    document: {
      body,
      createTreeWalker(_root, kind) {
        const iterator = (kind === 4 ? nodes : [body, ...blocks]).values();
        return { nextNode: () => iterator.next().value ?? null };
      },
    },
  });
}

test("QA joins adjacent React text nodes and words split by inline markup", () => {
  assert.equal(includes("Client 5fe2f9d", [{ text: "Client " }, { text: "5fe2f9d" }]), true);
  assert.equal(includes("Client", [{ text: "Cli", inline: true }, { text: "ent", inline: true }]), true);
});
test("QA retains block boundaries and excludes hidden text", () => {
  const blocks = [{ text: "Client", block: 0 }, { text: "revision", block: 1 }];
  assert.equal(includes("Client revision", blocks), true);
  assert.equal(includes("Clientrevision", blocks), false);
  assert.equal(includes("hidden value", [{ text: "hidden ", hidden: true }, { text: "value" }]), false);
});
test("a changed dependency fails patching instead of silently losing the repair", () => {
  assert.throws(() => patchBrowserQa(patched), /no longer matches/);
  assert.throws(() => patchBrowserQa(source + source), /no longer matches/);
});
