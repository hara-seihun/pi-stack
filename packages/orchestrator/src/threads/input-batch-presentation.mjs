export function inputBatchPresentation(message) {
  if (message?.customType !== "thread_input_batch") return { ok: true, value: null };
  if (!Array.isArray(message.content) || !Array.isArray(message.details?.workIds) || !message.details.workIds.length)
    return { ok: false, error: "Native input batch has no exact content and work IDs" };
  const inputs = [], ids = new Set();
  for (const block of message.content) {
    if (block?.type === "text") {
      let input;
      try { input = JSON.parse(block.text); } catch { return { ok: false, error: "Native input batch has malformed input metadata" }; }
      if (typeof input?.workId !== "string" || !input.workId || ids.has(input.workId) || typeof input.message !== "string"
        || input.inputOrigin !== undefined && !["human", "machine"].includes(input.inputOrigin)) return { ok: false, error: "Native input batch input identity or origin is invalid" };
      ids.add(input.workId);
      inputs.push({ role: "user", inputId: input.workId, ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}), timestamp: message.timestamp,
        content: [{ type: "text", text: input.message }] });
    } else if (block?.type === "image" && inputs.length) inputs.at(-1).content.push(block);
    else return { ok: false, error: "Native input batch has an unowned or unsupported content block" };
  }
  if (inputs.length !== message.details.workIds.length || inputs.some((input, index) => input.inputId !== message.details.workIds[index]))
    return { ok: false, error: "Native input batch work IDs disagree with its durable content order" };
  return { ok: true, value: inputs };
}
