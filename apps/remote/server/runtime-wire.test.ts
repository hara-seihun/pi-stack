import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRuntimeEvent, remoteRuntimeOutput } from './runtime-wire.mjs';
import { messageFinalizationKey } from './sync';
import { openCoreSession } from '../../../packages/orchestrator/src/cores/index';
import { readCoreRecords, readPortableConversation } from '../../../packages/orchestrator/src/cores/journal';
import type { CoreOutput } from '../../../packages/orchestrator/src/cores/contracts';

const image = { type: 'image', mimeType: 'image/png', data: 'x'.repeat(2 * 1024 * 1024) };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test('child image and token bursts never enter the Remote output callback', () => {
  const wire: unknown[] = [];
  const output = remoteRuntimeOutput((event: unknown) => wire.push(event));
  for (let i = 0; i < 1_000; i++) {
    output({ type: 'core_child_event', agentId: 'child', get event() { throw new Error('Remote must not traverse child payloads'); } });
  }
  expect(wire).toEqual([]);
});

test('root token traffic is linear in deltas, not accumulated assistant snapshots', () => {
  const message = { role: 'assistant', content: [image, { type: 'thinking', thinking: 'history'.repeat(50_000) }] };
  const wire: CoreOutput[] = [];
  const output = remoteRuntimeOutput((event: CoreOutput) => wire.push(event));
  for (let i = 0; i < 1_000; i++) output({ type: 'message_update', message,
    assistantMessageEvent: { type: 'text_delta', delta: 'token ', partial: message, contentIndex: 1 } });
  expect(wire.map(event => (event.assistantMessageEvent as any).delta).join('')).toBe('token '.repeat(1_000));
  expect(bytes(wire)).toBeLessThan(110_000);
  expect(projectRuntimeEvent({ type: 'message_update', message,
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thought', partial: message } }))
    .toEqual({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thought' } });
  expect(projectRuntimeEvent({ type: 'message_update', message,
    assistantMessageEvent: { type: 'thinking_start', content: message, partial: message } }))
    .toEqual({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
  expect(projectRuntimeEvent({ type: 'message_update', message,
    assistantMessageEvent: { type: 'thinking_end', content: 'non-streamed thought', partial: message } }))
    .toEqual({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'non-streamed thought' } });
});

test('root completion preserves finalization identity and canonical context without copying native sidecars', () => {
  const message = { role: 'assistant', timestamp: 123, stopReason: 'error', rawStopReason: 'refusal', errorMessage: 'provider failed',
    content: [{ type: 'text', text: 'answer', textSignature: 'signature' }, image,
      { type: 'thinking', thinking: 'thought', thinkingSignature: 'native' }], usage: { output: 12 }, details: { image } };
  const projected = projectRuntimeEvent({ type: 'message_end', message })!;
  expect(messageFinalizationKey(projected.message)).toBe(messageFinalizationKey(message));
  expect(projected.message).toEqual({ role: message.role, timestamp: message.timestamp, content: message.content,
    stopReason: message.stopReason, rawStopReason: message.rawStopReason, errorMessage: message.errorMessage });
  const context = { type: 'context_update', core: 'pi', context: { systemPrompt: 'instructions', tools: [], messages: [message] },
    finalizesMessage: messageFinalizationKey(message) };
  expect(projectRuntimeEvent(context)).toBe(context);
  expect(projectRuntimeEvent({ type: 'message_end', message: { role: 'toolResult', content: [image] } }))
    .toEqual({ type: 'message_end', message: { role: 'toolResult' } });
});

test('tool previews are bounded before serialization and retain result text, image markers and errors', () => {
  const source = { type: 'tool_execution_end', toolCallId: 'call', toolName: 'image_generation', isError: true,
    result: { content: [{ type: 'text', text: 'saved /tmp/image.png' }, image, { type: 'text', text: 'finished' }], details: { image } } };
  expect(projectRuntimeEvent(source)).toEqual({ type: source.type, toolCallId: 'call', toolName: 'image_generation', isError: true,
    result: { content: [{ type: 'text', text: 'saved /tmp/image.png\n[image · image/png]\nfinished' }] } });
  const long = projectRuntimeEvent({ ...source, result: { content: [{ type: 'text', text: 'a'.repeat(50_000) }, image] } })!;
  expect((long.result as any).content[0].text).toBe('a'.repeat(20_001));
  expect(bytes(long)).toBeLessThan(21_000);
  const shortArgs = { path: '/tmp/output.png', width: 1024 };
  expect(projectRuntimeEvent({ type: 'tool_execution_start', args: shortArgs })!.args).toBe(shortArgs);
  for (const value of [image.data, '\\"'.repeat(30_000), '\u0000'.repeat(30_000), '你好'.repeat(30_000)]) {
    const start = projectRuntimeEvent({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'tool', args: { value } })!;
    expect((start.args as any).truncated).toBe(true);
    expect(JSON.stringify(start.args).length).toBeLessThanOrEqual(12_000);
  }
});

test('lifecycle consumers retain state, queue counts, retry failures, compaction outcomes and UI cancellation IDs', () => {
  const state = { model: { id: 'astra', provider: 'openai-codex' }, sessionFile: '/native/session.jsonl', sessionName: 'thread',
    nativeSessionId: 'native', thinkingLevel: 'high', messageCount: 5, isStreaming: false, isCompacting: false,
    coreBusy: true, treeComplete: false, pendingMessageCount: 1, terminalError: 'child failed', unresolvedCommands: ['work'],
    coreAgents: [{ id: 'child', state: 'running' }] };
  const response = { type: 'response', id: 'state', command: 'get_state', success: true, data: { ...state,
    context: { messages: [image] }, lastAssistantMessage: { content: [image] } } };
  expect(projectRuntimeEvent(response)).toEqual({ ...response, data: state });
  const agent = { id: 'child', parentId: 'root', state: 'idle', name: 'worker', model: 'sol', nativeSessionId: 'native-child' };
  expect(projectRuntimeEvent({ type: 'core_agent', agent, nativeSessionFile: '/child.jsonl', workId: 'work' }))
    .toEqual({ type: 'core_agent', agent });
  const queue = projectRuntimeEvent({ type: 'queue_update', steering: [{ images: [image] }], followUp: ['a', 'b'] })!;
  expect(queue).toEqual({ type: 'queue_update', steering: [null], followUp: [null, null] });
  for (const event of [
    { type: 'auto_retry_end', success: false, finalError: 'retry failed' },
    { type: 'core_error', error: 'accounting failed', willRetry: false },
    { type: 'extension_ui_request', method: 'input', id: 'cancel-me' },
  ]) expect(projectRuntimeEvent({ ...event, ignored: image })).toEqual(event);
  expect(projectRuntimeEvent({ type: 'compaction_end', result: { summary: image.data } }))
    .toEqual({ type: 'compaction_end', result: true });
  expect(projectRuntimeEvent({ type: 'compaction_end', errorMessage: 'deadline', aborted: false, willRetry: true }))
    .toEqual({ type: 'compaction_end', result: false, errorMessage: 'deadline', aborted: false, willRetry: true });
  for (const type of ['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start',
    'tool_execution_update', 'conversation_replaced', 'extension_error', 'auto_retry_start', 'compaction_start', 'new_native_event']) {
    expect(projectRuntimeEvent({ type, messages: [image], partialResult: { content: [image] } })).toEqual({ type });
  }
});

test('explicit transcript and inspection responses remain complete, including failed command receipts', () => {
  for (const command of ['get_portable_conversation', 'core_agent_read', 'get_entries', 'get_messages', 'get_core_context',
    'core_agent_command', 'fork', 'get_commands', 'get_available_models', 'get_available_thinking_levels', 'prompt', 'compact']) {
    const event = { type: 'response', id: 'request', command, success: true, data: { content: [image] } };
    expect(projectRuntimeEvent(event)).toBe(event);
  }
  const error = { type: 'response', id: 'request', command: 'get_state', success: false, error: 'core failed' };
  expect(projectRuntimeEvent(error)).toBe(error);
});

test('the core journals full root and child records before Remote projects them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-wire-'));
  const wire: CoreOutput[] = [];
  const child = { id: 'child', parentId: 'root', name: 'worker', state: 'idle', model: 'sol', nativeSessionId: 'native-child' };
  const childMessage = { id: 'child-result', role: 'toolResult', toolCallId: 'image-call', content: [image], usage: { output: 42 } };
  const rootMessage = { role: 'assistant', timestamp: 456, content: [{ type: 'text', text: 'done' }], usage: { output: 7 } };
  const events: CoreOutput[] = [
    { type: 'core_agent', agent: child, nativeSessionFile: '/native/child.jsonl', workId: 'work' },
    { type: 'core_child_event', agentId: 'child', event: { type: 'tool_execution_end', toolCallId: 'image-call', result: { content: [image] } } },
    { type: 'core_child_event', agentId: 'child', event: { type: 'message_end', message: childMessage } },
    { type: 'message_end', message: rootMessage },
    { type: 'agent_settled' },
  ];
  const before = JSON.stringify(events);
  const core = await openCoreSession({ cwd: directory, args: [], env: { PI_STACK_CORE: 'pi' }, sessionId: 'root', stateDir: directory },
    remoteRuntimeOutput((event: CoreOutput) => wire.push(event)), () => {}, async (_options, output) => ({
      async command() { for (const event of events) output(event); }, async close() {},
    }));
  try {
    await core.command({ type: 'prompt' });
    expect(JSON.stringify(events)).toBe(before);
    expect(wire.map(event => event.type)).toEqual(['core_agent', 'message_end', 'agent_settled']);
    expect(bytes(wire)).toBeLessThan(600);
    const childDir = join(directory, 'children', createHash('sha256').update('child').digest('hex'));
    expect(readPortableConversation(join(childDir, 'conversation.jsonl'), 'pi').messages).toEqual([childMessage]);
    expect(readCoreRecords(join(childDir, 'activity.jsonl')).map(record => record.type)).toEqual(['tool_execution_end', 'message_end']);
    expect(readCoreRecords(join(childDir, 'activity.jsonl'))[0]!.result.content).toEqual([image]);
    expect(JSON.parse(readFileSync(join(directory, 'agents.json'), 'utf8'))).toEqual([child]);
    expect(readPortableConversation(join(directory, 'conversation.jsonl'), 'pi').messages).toEqual([rootMessage]);
    await core.command({ type: 'get_portable_conversation', id: 'export' });
    expect((wire.at(-1)!.data as any).messages).toEqual([rootMessage]);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
