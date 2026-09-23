// Adapted from @ogulcancelik/pi-codex-compaction 0.1.5. See LICENSE and README.md.
export const KIND = "openai-codex-native-compaction";
export const VERSION = 2;
export const FEATURE = "remote_compaction_v2";
export const USER_TOKEN_BUDGET = 64_000;

export const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const isCodex = model => model?.api === "openai-codex-responses";
export const modelKey = model => `${model.api}:${model.id}`;
export const failure = error => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
export const success = value => ({ ok: true, value });

export function featureHeader(value) {
  return [...new Set([...(value ?? "").split(",").map(part => part.trim()).filter(Boolean), FEATURE])].join(",");
}

export function parseDetails(value) {
  if (!object(value) || value.kind !== KIND || value.version !== VERSION || typeof value.modelKey !== "string") return failure("Malformed Codex checkpoint metadata");
  const history = value.replacementHistory;
  if (!Array.isArray(history) || !history.length || history.some(item => !object(item))) return failure("Malformed Codex checkpoint history");
  const checkpoints = history.filter(item => item.type === "compaction");
  if (checkpoints.length !== 1 || history.at(-1) !== checkpoints[0] || typeof checkpoints[0].encrypted_content !== "string" || !checkpoints[0].encrypted_content) return failure("Codex checkpoint must end in exactly one encrypted compaction item");
  if (history.slice(0, -1).some(item => item.role !== "user" || !(typeof item.content === "string" || Array.isArray(item.content)))) return failure("Codex checkpoint contains invalid retained user messages");
  return success(value);
}

export function findCheckpoint(branch) {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "compaction") continue;
    if (entry.details?.kind !== KIND) return success(undefined);
    const parsed = parseDetails(entry.details);
    return parsed.ok ? success({ entry, index, details: parsed.value }) : parsed;
  }
  return success(undefined);
}

function itemText(item) {
  if (typeof item.content === "string") return item.content;
  return Array.isArray(item.content) ? item.content.map(part => typeof part.text === "string" ? part.text : "").join("") : "";
}

function truncateMiddle(text, maxCharacters) {
  if (text.length <= maxCharacters) return text;
  if (maxCharacters <= 1) return text.slice(-maxCharacters);
  const available = maxCharacters - 1;
  const head = Math.ceil(available / 2), tail = Math.floor(available / 2);
  return `${text.slice(0, head)}…${tail ? text.slice(-tail) : ""}`;
}

export function retainRecentUsers(input, budget = USER_TOKEN_BUDGET) {
  const retained = [];
  let remaining = budget;
  for (const item of [...input].reverse()) {
    if (remaining <= 0) break;
    if (item.role !== "user" || (item.type !== undefined && item.type !== "message") || !itemText(item).trim()) continue;
    const copy = structuredClone(item);
    const tokens = Math.max(1, Math.ceil(itemText(item).length / 4));
    if (tokens > remaining) {
      if (typeof copy.content === "string") copy.content = truncateMiddle(copy.content, remaining * 4);
      else {
        let characters = remaining * 4, left = itemText(item).length;
        copy.content = copy.content.flatMap(part => {
          if (typeof part.text !== "string") return [part];
          const allocation = left ? Math.floor(part.text.length / left * characters) : 0;
          characters -= allocation;
          left -= part.text.length;
          const text = truncateMiddle(part.text, allocation);
          return text ? [{ ...part, text }] : [];
        });
      }
    }
    retained.push(copy);
    remaining -= Math.min(tokens, remaining);
  }
  return retained.reverse();
}

export function replaceMarker(payload, marker, history) {
  if (!object(payload) || !Array.isArray(payload.input)) return failure("Codex provider did not serialize a Responses input array");
  const positions = payload.input.flatMap((item, index) => item.role === "user" && itemText(item) === marker ? [index] : []);
  if (positions.length !== 1) return failure("Codex checkpoint marker was removed or duplicated by a context extension");
  const index = positions[0];
  const result = { ...payload, input: [...payload.input.slice(0, index), ...structuredClone(history), ...payload.input.slice(index + 1)] };
  delete result.previous_response_id;
  return success(result);
}

export function compactionPayload(payload) {
  if (!object(payload) || !Array.isArray(payload.input)) return failure("Codex provider did not serialize a Responses input array");
  const body = { ...payload, store: false, stream: true, input: [...payload.input, { type: "compaction_trigger" }] };
  delete body.previous_response_id;
  return success(body);
}

/** Observes Pi's SSE bytes without replacing its HTTP or response parser. */
export function compactionObserver(onEvent = () => {}, onBytes = () => {}) {
  let decoder = new TextDecoder();
  let buffer = "", error, terminal = false, item;
  const accept = candidate => {
    if (candidate?.type !== "compaction") return;
    if (typeof candidate.encrypted_content !== "string" || !candidate.encrypted_content) { error = "Empty encrypted compaction item"; return; }
    if (item && (item.encrypted_content !== candidate.encrypted_content || item.id !== candidate.id)) { error = "Multiple encrypted compaction items"; return; }
    item = candidate;
  };
  const block = text => {
    const data = text.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); } catch { error = "Malformed compaction SSE event"; return; }
    onEvent(event);
    if (event.type === "response.output_item.done") accept(event.item);
    if (event.type === "response.completed" || event.type === "response.done") {
      if (event.response?.status && event.response.status !== "completed") error = `Compaction response ${event.response.status}`;
      terminal = true;
      for (const candidate of event.response?.output ?? []) accept(candidate);
    }
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) error = `Compaction stream ended with ${event.type}`;
  };
  const feed = (bytes, done = false) => {
    if (bytes) onBytes(bytes.byteLength);
    buffer += decoder.decode(bytes, { stream: !done });
    let match;
    while ((match = /\r?\n\r?\n/u.exec(buffer))) {
      block(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (done && buffer.trim()) { block(buffer); buffer = ""; }
  };
  return {
    wrap(response) {
      decoder = new TextDecoder();
      buffer = "";
      error = undefined;
      terminal = false;
      item = undefined;
      if (!response.ok || !response.body) return response;
      const body = response.body.pipeThrough(new TransformStream({
        transform(bytes, controller) { feed(bytes); controller.enqueue(bytes); },
        flush() { feed(undefined, true); },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    result() {
      if (error) return failure(error);
      if (!terminal) return failure("Compaction stream ended before response.completed");
      return item ? success(item) : failure("Codex returned no encrypted compaction item");
    },
  };
}

