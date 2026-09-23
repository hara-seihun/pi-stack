import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { withAnthropicFiles, anthropicFilesHeaders } from "../dist/auth/anthropic-files-provider.js";
import { aliasProvider } from "../dist/auth/provider-alias.js";
import { providerOAuth, defaultSharedAuthPath } from "../dist/auth/shared-oauth.js";
import { defaultLedgerPath } from "../dist/extension/routing.js";
import { withCustomModels } from "../dist/models.js";

const { values } = parseArgs({ options: {
  account: { type: "string" }, image: { type: "string" }, prompt: { type: "string" },
  model: { type: "string", default: "claude-fable-5-1" },
} });
if (!values.account || !values.image || !values.prompt) throw new Error("Required: --account ALIAS --image PNG --prompt TEXT. Makes two model requests and deletes its uploaded file.");
const family = withCustomModels(builtinProviders().find(provider => provider.id === "anthropic"));
const auth = providerOAuth(family, defaultSharedAuthPath(defaultLedgerPath()));
const credential = await auth.resolve(values.account, AbortSignal.timeout(20_000));
const base = family.getModels().find(model => model.id === values.model);
assert(base, `Unknown model ${values.model}`);
const model = { ...base, provider: values.account };
const bytes = await readFile(values.image);
const messages = [{ role: "user", timestamp: Date.now(), content: [
  { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
  { type: "text", text: values.prompt },
] }];
const original = JSON.stringify(messages);
const cacheRoot = await mkdtemp(join(tmpdir(), "pi-anthropic-files-probe-"));
const fileIds = new Set(), requests = [], replies = [];
let uploads = 0;
const fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (url.pathname === "/v1/messages") {
    const body = await request.clone().text();
    assert(!body.includes('"base64"'), "Image bytes reached the Messages request");
    const payload = JSON.parse(body);
    const images = payload.messages.flatMap(message => message.content ?? []).filter(block => block.type === "image");
    assert.equal(images.length, 1);
    assert.equal(images[0].source.type, "file");
    fileIds.add(images[0].source.file_id);
    requests.push({ bytes: Buffer.byteLength(body), fileId: images[0].source.file_id });
  }
  const response = await globalThis.fetch(request);
  if (url.pathname === "/v1/files" && request.method === "POST") {
    uploads++;
    const result = await response.clone().json();
    if (result.id) fileIds.add(result.id);
  }
  return response;
};
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const provider = aliasProvider(withAnthropicFiles(family, cacheRoot), values.account);
    const response = await provider.streamSimple(model, { messages }, {
      ...credential, fetch, signal: AbortSignal.timeout(45_000), maxTokens: 128,
    }).result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    replies.push({ id: response.responseId, text: response.content.filter(block => block.type === "text").map(block => block.text).join("") });
  }
  assert.equal(uploads, 1);
  assert.equal(fileIds.size, 1);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(messages), original);
  console.log(JSON.stringify({ account: values.account, uploads, requests, replies, originalPreserved: true }));
} finally {
  const headers = anthropicFilesHeaders(model, credential);
  for (const id of fileIds) {
    const response = await globalThis.fetch(new URL(`/v1/files/${encodeURIComponent(id)}`, model.baseUrl), {
      method: "DELETE", headers, signal: AbortSignal.timeout(10_000),
    });
    assert(response.ok || response.status === 404, `Probe cleanup failed for ${id}: HTTP ${response.status}; cache retained at ${cacheRoot}`);
  }
  await rm(cacheRoot, { recursive: true, force: true });
}
