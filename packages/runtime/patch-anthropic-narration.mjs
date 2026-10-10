import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helpers = readFileSync(new URL("../orchestrator/src/threads/anthropic-narration.mjs", import.meta.url), "utf8").replace(/^export /gm, "");
const marker = "// PiStack signed Anthropic narration\n";

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Pinned Anthropic narration boundary changed: ${before}`);
  return source.replace(before, after);
}

export function patchAnthropicNarration(source) {
  if (source.startsWith(marker + helpers)) return source;
  if (source.includes(marker)) throw new Error("Anthropic narration helper differs; rebuild the immutable dependency tree");
  if (source.includes('else if (event.type === "content_block_stop")')) {
    source = replace(source,
      `else if (event.type === "content_block_stop") {
                    const index = blocks.findIndex((b) => b.index === event.index);
                    const block = blocks[index];
                    if (block) {
                        delete block.index;`,
      `else if (event.type === "content_block_stop") {
                    const index = blocks.findIndex((b) => b.index === event.index);
                    let block = blocks[index];
                    if (block) {
                        const narration = anthropicNarrationText(block);
                        if (narration) {
                            block = blocks[index] = narration;
                            stream.push({ type: "text_start", contentIndex: index, partial: output });
                        }
                        delete block.index;`);
    source = replace(source,
      `for (const block of msg.content) {
                if (block.type === "text") {
                    if (block.text.trim().length === 0)`,
      `for (const block of msg.content) {
                if (block.type === "text") {
                    const narrationSignature = anthropicNarrationReplaySignature(block.textSignature);
                    if (narrationSignature) {
                        blocks.push({ type: "thinking", thinking: sanitizeSurrogates(block.text), signature: narrationSignature });
                        continue;
                    }
                    if (block.text.trim().length === 0)`);
  } else if (source.includes('event.type==="content_block_stop"')) {
    source = replace(source,
      `else if(event.type==="content_block_stop"){let index=blocks.findIndex(b=>b.index===event.index),block=blocks[index];block&&(delete block.index,`,
      `else if(event.type==="content_block_stop"){let index=blocks.findIndex(b=>b.index===event.index),block=blocks[index];if(block){let narration=anthropicNarrationText(block);if(narration){block=blocks[index]=narration;stream2.push({type:"text_start",contentIndex:index,partial:output})}}block&&(delete block.index,`);
    source = replace(source,
      `for(let block of msg.content)if(block.type==="text"){if(block.text.trim().length===0)`,
      `for(let block of msg.content)if(block.type==="text"){let narrationSignature=anthropicNarrationReplaySignature(block.textSignature);if(narrationSignature){blocks.push({type:"thinking",thinking:sanitizeSurrogates(block.text),signature:narrationSignature});continue}if(block.text.trim().length===0)`);
  } else throw new Error("Pinned Anthropic stream not found");
  return marker + helpers + "\n" + source;
}

export function patchAnthropicNarrationCopies(nodeModules) {
  const sdk = join(nodeModules, "@earendil-works/pi-ai/dist/api/anthropic-messages.js");
  const chunks = join(nodeModules, "@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const bundled = readdirSync(chunks).filter(name => /^anthropic-messages-.*\.js$/.test(name));
  if (bundled.length !== 1) throw new Error("Pinned Anthropic bundle must have one messages provider");
  for (const path of [sdk, join(chunks, bundled[0])]) {
    const source = readFileSync(path, "utf8");
    const patched = patchAnthropicNarration(source);
    if (source !== patched) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-anthropic-narration.mjs NODE_MODULES");
  patchAnthropicNarrationCopies(resolve(process.argv[2]));
}
