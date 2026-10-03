export async function boundedSummarization(model, context, options, request, combineUsage) {
  const userIndex = context.messages?.findIndex(message => message.role === "user");
  const user = context.messages?.[userIndex];
  const text = user?.content?.[0]?.text;
  const budget = Math.floor((model.contextWindow - (options.maxTokens ?? 0) - 8192) / 2);
  let usage;
  let calls = 0;
  const withText = value => ({ ...context, messages: context.messages.map((message, index) => index === userIndex ? { ...message, content: [{ type: "text", text: value }] } : message) });
  const account = response => {
    if (response.usage) usage = usage ? combineUsage(usage, response.usage) : response.usage;
    return { ...response, ...(usage ? { usage } : {}) };
  };
  const call = async (prompt, recovery = false) => {
    options.signal?.throwIfAborted();
    if (++calls > 32) throw new Error("Summarization recovery exceeded 32 requests; context remains unchanged");
    const nextOptions = { ...options };
    if (recovery) delete nextOptions.reasoning;
    let response = await request(withText(prompt), nextOptions);
    account(response);
    if (response.stopReason === "length") {
      options.signal?.throwIfAborted();
      if (++calls > 32) throw new Error("Summarization recovery exceeded 32 requests; context remains unchanged");
      const conciseOptions = { ...nextOptions };
      delete conciseOptions.reasoning;
      response = await request(withText(`${prompt}\n\nProduce a concise complete checkpoint, at most 1000 words. Preserve pending work, decisions and essential identifiers. Do not exhaust the output budget.`), conciseOptions);
      account(response);
    }
    return { ...response, ...(usage ? { usage } : {}) };
  };
  if (typeof text !== "string" || context.messages.filter(message => message.role !== "system").length !== 1 || user.content.length !== 1) {
    return request(context, options);
  }
  const overflow = response => response.stopReason === "error" && /prompt (?:is )?too long|maximum context length|context_length_exceeded|request_too_large/i.test(response.errorMessage ?? "");
  // UTF-8 bytes conservatively bound text tokens; leave half the input window for framing and tokenizer differences.
  if (!(budget > 0) || Buffer.byteLength(text) <= budget) {
    const response = await call(text);
    if (!overflow(response)) return response;
  }
  let start, end;
  if (text.startsWith("<conversation>\n")) {
    start = "<conversation>\n".length;
    end = text.lastIndexOf("\n</conversation>");
  } else if (text.startsWith("# Conversation\n")) {
    start = "# Conversation\n".length;
    end = text.lastIndexOf("\n\n# Instructions\n");
  }
  if (start === undefined || end < start || budget <= 0) {
    throw new Error("Summarization input exceeds its recovery budget; context remains unchanged");
  }
  const conversation = text.slice(start, end);
  const tail = text.slice(end).replace(/\n\n<previous-summary>\n[\s\S]*?\n<\/previous-summary>\n\n/, "\n\n");
  let checkpoint = text.match(/<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/)?.[1] ?? "";
  let offset = 0;
  let chunkBudget = budget;
  let finalResponse;
  while (offset < conversation.length) {
    options.signal?.throwIfAborted();
    const prefix = `${text.slice(0, start)}${checkpoint ? `[Checkpoint from preceding segments]:\n${checkpoint}\n\n` : ""}`;
    const suffix = `${tail}\n\nMerge the preceding checkpoint with this next conversation segment into one concise complete checkpoint. Do not reconstruct later segments. At most 1000 words.`;
    const available = chunkBudget - Buffer.byteLength(prefix + suffix);
    if (available < 1024) throw new Error("Summarization checkpoint or instructions exceed the recovery budget; context remains unchanged");
    let next = Math.min(conversation.length, offset + available);
    // Never split a surrogate pair. No source text is omitted, including individual oversized messages.
    if (next < conversation.length && /[\uD800-\uDBFF]/.test(conversation[next - 1])) next--;
    while (Buffer.byteLength(conversation.slice(offset, next)) > available) {
      next = offset + Math.floor((next - offset) / 2);
      if (/[\uD800-\uDBFF]/.test(conversation[next - 1])) next--;
    }
    const response = await call(prefix + conversation.slice(offset, next) + suffix, true);
    if (overflow(response)) {
      chunkBudget = Math.floor(chunkBudget / 2);
      continue;
    }
    if (response.stopReason !== "stop" || response.content.some(block => block.type === "toolCall")) return response;
    checkpoint = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (!checkpoint.trim()) throw new Error("Summarization returned an empty checkpoint; context remains unchanged");
    offset = next;
    finalResponse = response;
  }
  if (!finalResponse) throw new Error("Summarization has no conversation to reduce; context remains unchanged");
  return finalResponse;
}
