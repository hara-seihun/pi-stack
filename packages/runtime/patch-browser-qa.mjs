import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sourceBlock = `  const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let visitedText = 0;
  for (let node = textWalker.nextNode(); node && visitedText < 6000; node = textWalker.nextNode(), visitedText += 1) {
    if (!hasVisibleAncestors(node)) continue;
    if (normalize(node.nodeValue).includes(expected)) return true;
  }
  const elementWalker`;
const replacement = `  const textContainer = (node) => {
    for (let element = node.parentElement; element; element = element.parentElement) {
      const display = window.getComputedStyle(element).display;
      if (element === root || !["inline", "inline-block", "inline-flex", "inline-grid", "contents"].includes(display)) return element;
    }
    return root;
  };
  const renderedTextParts = [];
  let previousContainer = null;
  const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let visitedText = 0;
  for (let node = textWalker.nextNode(); node && visitedText < 6000; node = textWalker.nextNode(), visitedText += 1) {
    if (!hasVisibleAncestors(node)) continue;
    if (normalize(node.nodeValue).includes(expected)) return true;
    const container = textContainer(node);
    if (previousContainer && container !== previousContainer) renderedTextParts.push(" ");
    renderedTextParts.push(node.nodeValue || "");
    previousContainer = container;
  }
  if (normalize(renderedTextParts.join("")).includes(expected)) return true;
  const elementWalker`;

export function patchBrowserQa(source) {
  if (source.split(sourceBlock).length !== 2) throw new Error("Browser QA visible-text patch no longer matches the pinned dependency");
  return source.replace(sourceBlock, replacement);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error("Expected the pinned browser job.js path");
  writeFileSync(path, patchBrowserQa(readFileSync(path, "utf8")));
}
