const TOOL_ARGS_LIMIT = 12_000;
const TOOL_OUTPUT_LIMIT = 20_000;

function fields(value, names) {
  return Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
}

function toolArgs(args) {
  const encoded = JSON.stringify(args ?? {});
  if (encoded.length <= TOOL_ARGS_LIMIT) return args ?? {};
  // The supervisor bounds JSON again. Leave room for escaping and the wrapper
  // so it keeps this preview rather than wrapping it in a second preview.
  return { truncated: true, preview: encoded.slice(0, (TOOL_ARGS_LIMIT - 100) / 2) + '…' };
}

function toolOutput(result) {
  let text = '';
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    const part = block?.type === 'text' ? String(block.text ?? '')
      : block?.type === 'image' ? `[image${block.mimeType ? ` · ${block.mimeType}` : ''}]`
        : block ? JSON.stringify(block) : '';
    if (!part) continue;
    if (text) text += '\n';
    // One extra character lets the supervisor apply its existing truncation
    // notice, yielding exactly the same tool_end output as the native result.
    text += part.slice(0, TOOL_OUTPUT_LIMIT + 1 - text.length);
    if (text.length > TOOL_OUTPUT_LIMIT) break;
  }
  return { content: [{ type: 'text', text }] };
}

export function projectRuntimeEvent(event) {
  const type = event.type;
  switch (type) {
    case 'core_child_event': return null;
    case 'response': {
      if (event.command !== 'get_state' || !event.success || !event.data) return event;
      const { context, lastAssistantMessage, ...data } = event.data;
      return { ...event, data };
    }
    case 'context_update': return event;
    case 'core_agent': return { type, agent: event.agent };
    case 'queue_update': return { type,
      steering: Array(Array.isArray(event.steering) ? event.steering.length : 0).fill(null),
      followUp: Array(Array.isArray(event.followUp) ? event.followUp.length : 0).fill(null) };
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (update?.type === 'text_delta' || update?.type === 'thinking_delta') {
        return { type, assistantMessageEvent: fields(update, ['type', 'delta']) };
      }
      if (update?.type === 'thinking_start') return { type, assistantMessageEvent: { type: update.type } };
      if (update?.type === 'thinking_end') {
        return { type, assistantMessageEvent: fields(update, ['type', 'content']) };
      }
      return { type };
    }
    case 'message_end': return { type, message: fields(event.message, event.message?.role === 'assistant'
      ? ['role', 'timestamp', 'content', 'stopReason', 'rawStopReason', 'errorMessage'] : ['role']) };
    case 'tool_execution_start': return { type, ...fields(event, ['toolCallId', 'toolName']), args: toolArgs(event.args) };
    case 'tool_execution_update': return { type, ...fields(event, ['toolCallId', 'toolName']), partialResult: toolOutput(event.partialResult) };
    case 'tool_execution_end': return { type, ...fields(event, ['toolCallId', 'toolName', 'isError']), result: toolOutput(event.result) };
    case 'auto_retry_end': return { type, ...fields(event, ['success', 'finalError']) };
    case 'compaction_end': return { type, ...fields(event, ['aborted', 'willRetry', 'errorMessage']), result: Boolean(event.result) };
    case 'core_error': return { type, ...fields(event, ['error', 'willRetry']) };
    case 'extension_ui_request': return { type, ...fields(event, ['id', 'method']) };
    // Unhandled root events still invalidate the supervisor's in-flight state
    // snapshot. Their native bodies have no Remote consumer.
    default: return { type };
  }
}

export function remoteRuntimeOutput(output) {
  return event => {
    const projected = projectRuntimeEvent(event);
    if (projected) output(projected);
  };
}
