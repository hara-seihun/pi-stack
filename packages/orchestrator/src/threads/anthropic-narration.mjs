function signatureFields(bytes) {
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 53 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++];
      value += (byte & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) return null;
      if (byte < 128) return value;
    }
    return null;
  };
  const fields = [];
  while (offset < bytes.length) {
    const key = varint();
    if (key === null || key < 8) return null;
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      if (varint() === null) return null;
      fields.push({ number });
    } else if (wire === 2) {
      const length = varint();
      if (length === null || length > bytes.length - offset) return null;
      fields.push({ number, bytes: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) return null;
      fields.push({ number });
    } else return null;
  }
  return fields;
}

/** Anthropic's signed envelope identifies its channel at protobuf field 2.1.8. */
export function anthropicSignatureChannel(signature) {
  const unrecognized = { kind: "unrecognized" };
  if (typeof signature !== "string" || !signature || signature.length > 65_536
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 === 1) return unrecognized;
  let bytes;
  try { bytes = Uint8Array.from(atob(signature), character => character.charCodeAt(0)); }
  catch { return unrecognized; }
  for (const fieldNumber of [2, 1, 8]) {
    const fields = signatureFields(bytes);
    if (!fields) return unrecognized;
    const matches = fields.filter(field => field.number === fieldNumber);
    if (matches.length !== 1 || !matches[0].bytes) return unrecognized;
    bytes = matches[0].bytes;
  }
  const channel = new TextDecoder().decode(bytes);
  return channel === "narration" || channel === "thinking"
    ? { kind: "channel", channel } : unrecognized;
}

export function anthropicNarrationText(block) {
  if (block.type !== "thinking" || block.redacted || typeof block.thinking !== "string") return null;
  const channel = anthropicSignatureChannel(block.thinkingSignature);
  if (channel.kind !== "channel" || channel.channel !== "narration") return null;
  return {
    type: "text",
    text: block.thinking,
    textSignature: JSON.stringify({ type: "anthropic-narration", signature: block.thinkingSignature }),
  };
}

export function anthropicNarrationReplaySignature(value) {
  if (typeof value !== "string" || !value.startsWith('{"type":"anthropic-narration",')) return null;
  let record;
  try { record = JSON.parse(value); } catch { return null; }
  if (record.type !== "anthropic-narration" || typeof record.signature !== "string") return null;
  const channel = anthropicSignatureChannel(record.signature);
  return channel.kind === "channel" && channel.channel === "narration" ? record.signature : null;
}

export function projectAnthropicNarrationMessage(message) {
  if (message.role !== "assistant" || message.api !== "anthropic-messages" || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    const text = anthropicNarrationText(block);
    if (!text) return block;
    changed = true;
    return text;
  });
  return changed ? { ...message, content } : message;
}
