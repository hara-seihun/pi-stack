import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { patchCodexSse } from "./patch-codex-sse.mjs";

const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses"));
const chunks = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/chunks");
const bundle = join(chunks, readdirSync(chunks).find(name => /^openai-codex-responses-[^.]+\.js$/u.test(name)));
for (const path of [sdk, bundle]) test(`Codex SSE framing in ${path.includes("chunks") ? "bundled CLI" : "SDK"}`, async () => {
  const source = patchCodexSse(readFileSync(path, "utf8"));
  assert.equal(patchCodexSse(source), source);
  const start = source.search(/async function\*\s*parseSSE\(/u);
  const end = source.indexOf("OPENAI_BETA_RESPONSES_WEBSOCKETS", start);
  const parserSource = source.slice(start, end).replace(/(?:const|var)\s*$/u, "");
  const parser = new Function("CodexProtocolError", "formatThrownValue", `${parserSource}; return parseSSE;`)(Error, String);
  for (const ending of ["\n", "\r\n"]) {
    const text = `data: {"a":1}${ending}${ending}data: {"b":2}${ending}${ending}`;
    for (const chunkSize of [1, text.length]) {
      const bytes = new TextEncoder().encode(text);
      const response = new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize)); controller.close(); } }));
      const values = [];
      for await (const value of parser(response)) values.push(value);
      assert.deepEqual(values, [{ a: 1 }, { b: 2 }]);
    }
  }
});
