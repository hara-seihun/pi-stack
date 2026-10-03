import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SimGateways, type GatewaySocket, type GatewaySpec } from './gateway.ts';

const specs: GatewaySpec[] = [
  { id: 'desk', name: 'Desk SIM', token: 'synthetic-desk-token-'.padEnd(40, 'a') },
  { id: 'travel', name: 'Travel SIM', token: 'synthetic-travel-token-'.padEnd(40, 'b') },
];
const callId = 'owned-call';
const number = '+442079460123';
const pcm = Buffer.alloc(640, 0x12);

class Socket implements GatewaySocket {
  sent: (string | Buffer)[] = [];
  closed: (number | undefined)[] = [];
  buffered = 0;
  result: unknown = 1;
  throws = false;
  send(data: string | Buffer): unknown {
    if (this.throws) throw new Error('synthetic socket failure');
    this.sent.push(data);
    return this.result;
  }
  close(code?: number): void { this.closed.push(code); }
  getBufferedAmount(): number { return this.buffered; }
  controls(): { type: string; callId?: string; number?: string; maxSeconds?: number }[] {
    return this.sent.filter((data): data is string => typeof data === 'string').map(data => JSON.parse(data));
  }
  frames(): Buffer[] { return this.sent.filter((data): data is Buffer => Buffer.isBuffer(data)); }
}

function fixture() {
  let now = 1_790_000_000_000;
  const states: { callId: string; state: string; error?: string }[] = [];
  const audio: { callId: string; data: Buffer }[] = [];
  const gateways = new SimGateways(specs, {
    state: (callId, state, error) => states.push({ callId, state, error }),
    audio: (callId, data) => audio.push({ callId, data }),
  }, () => now);
  const socket = new Socket();
  function control(message: unknown, id = 'desk', target = socket) {
    gateways.receive(id, target, JSON.stringify(message));
  }
  function connect(ready = true, id = 'desk', target = socket) {
    gateways.connected(id, target);
    control({ type: 'hello', id, sampleRate: 16000, ready }, id, target);
  }
  function dial() {
    assert.equal(gateways.reserve('desk', callId).ok, true);
    assert.equal(gateways.dial('desk', callId, number, 60).ok, true);
  }
  function active() {
    connect();
    dial();
    control({ type: 'call-state', callId, state: 'active' });
  }
  function failed() {
    assert.equal(gateways.snapshots()[0].connected, false);
    assert.equal(gateways.snapshots()[0].ready, false);
    assert.equal(gateways.snapshots()[0].callId, null);
    assert.ok(socket.closed.length > 0);
    assert.equal(states.filter(event => event.callId === callId && event.state === 'failed').length, 1);
    gateways.audio('desk', callId, pcm);
    gateways.receive('desk', socket, pcm);
    assert.equal(socket.frames().length, 0);
    assert.equal(audio.length, 0);
  }
  return { gateways, socket, states, audio, control, connect, dial, active, failed, advance: (ms: number) => { now += ms; } };
}

test('bearer tokens identify exactly one provisioned gateway', () => {
  const { gateways } = fixture();
  for (const spec of specs) assert.equal(gateways.authenticate(`Bearer ${spec.token}`), spec.id);
  for (const header of [null, '', specs[0].token, `Basic ${specs[0].token}`, `Bearer ${specs[0].token}x`, 'Bearer unknown', `Bearer ${specs[0].token.slice(1)}`]) {
    assert.equal(gateways.authenticate(header), null);
  }
  for (const invalid of [
    [specs[0], { ...specs[1], token: specs[0].token }],
    [specs[0], { ...specs[1], id: specs[0].id }],
    [{ ...specs[0], token: 'short' }],
    [{ ...specs[0], id: '../desk' }],
  ]) assert.throws(() => new SimGateways(invalid, { state() {}, audio() {} }));
});

test('a token-authenticated connection cannot claim another gateway in hello', () => {
  const f = fixture();
  f.gateways.connected('desk', f.socket);
  f.control({ type: 'hello', id: 'travel', sampleRate: 16000, ready: true });
  assert.equal(f.gateways.reserve('desk', callId).ok, false);
  assert.equal(f.gateways.reserve('travel', callId).ok, false);
  assert.equal(f.socket.controls().length, 0);
  assert.ok(f.socket.closed.length > 0);
});

for (const condition of ['unknown', 'disconnected', 'no hello', 'not ready', 'stale', 'busy'] as const) {
  test(`${condition} gateway cannot reserve or dispatch a new dial`, () => {
    const f = fixture();
    let id = 'desk';
    if (condition === 'unknown') id = 'missing';
    else if (condition === 'no hello') f.gateways.connected(id, f.socket);
    else if (condition !== 'disconnected') f.connect(condition !== 'not ready');
    if (condition === 'stale') f.advance(45_001);
    if (condition === 'busy') assert.equal(f.gateways.reserve(id, 'other-call').ok, true);
    assert.equal(f.gateways.reserve(id, callId).ok, false);
    assert.equal(f.gateways.dial(id, callId, number, 60).ok, false);
    assert.equal(f.socket.controls().filter(message => message.type === 'dial').length, 0);
  });
}

test('readiness withdrawal after reservation prevents dispatch and cleans the call', () => {
  const f = fixture();
  f.connect();
  assert.equal(f.gateways.reserve('desk', callId).ok, true);
  f.control({ type: 'hello', id: 'desk', sampleRate: 16000, ready: false, reason: 'Bluetooth disconnected' });
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  assert.equal(f.socket.controls().length, 0);
  f.failed();
});

test('freshness is checked again at dial, not only at reservation', () => {
  const f = fixture();
  f.connect();
  assert.equal(f.gateways.reserve('desk', callId).ok, true);
  f.advance(45_001);
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  assert.equal(f.socket.controls().filter(message => message.type === 'dial').length, 0);
});

test('a reservation dispatches once and never replays after reconnect', () => {
  const f = fixture();
  f.connect();
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  f.dial();
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  assert.deepEqual(f.socket.controls(), [{ type: 'dial', callId, number, maxSeconds: 60 }]);
  f.gateways.disconnected('desk', f.socket);
  const replacement = new Socket();
  f.connect(true, 'desk', replacement);
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  assert.equal(replacement.controls().length, 0);
});

test('an unconfirmed dispatch failure is never retried', () => {
  const f = fixture();
  f.connect();
  assert.equal(f.gateways.reserve('desk', callId).ok, true);
  f.socket.throws = true;
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  f.socket.throws = false;
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  assert.equal(f.socket.controls().length, 0);
  assert.equal(f.states.filter(event => event.state === 'failed').length, 1);
});

test('only active owned calls exchange 640-byte PCM, never idle or another gateway audio', () => {
  const f = fixture();
  f.connect();
  const other = new Socket();
  f.connect(true, 'travel', other);
  f.gateways.receive('desk', f.socket, pcm);
  f.gateways.audio('desk', callId, pcm);
  f.dial();
  f.gateways.receive('desk', f.socket, pcm);
  f.gateways.audio('desk', callId, pcm);
  assert.equal(f.audio.length, 0);
  assert.equal(f.socket.frames().length, 0);
  f.control({ type: 'call-state', callId, state: 'active' });
  f.gateways.receive('travel', other, pcm);
  f.gateways.audio('travel', callId, pcm);
  f.gateways.audio('desk', 'private-other-call', pcm);
  assert.equal(f.audio.length, 0);
  assert.equal(other.frames().length, 0);
  assert.equal(f.socket.frames().length, 0);
  f.gateways.receive('desk', f.socket, pcm);
  f.gateways.audio('desk', callId, pcm);
  assert.deepEqual(f.audio, [{ callId, data: pcm }]);
  assert.deepEqual(f.socket.frames(), [pcm]);
  f.control({ type: 'call-state', callId, state: 'ended' });
  f.gateways.receive('desk', f.socket, pcm);
  f.gateways.audio('desk', callId, pcm);
  assert.equal(f.audio.length, 1);
  assert.equal(f.socket.frames().length, 1);
});

test('wrong call IDs in API operations cannot dial, end or corrupt owned audio', () => {
  const f = fixture();
  f.active();
  assert.equal(f.gateways.dial('desk', 'other-call', number, 60).ok, false);
  f.gateways.end('desk', 'other-call');
  f.gateways.audio('desk', 'other-call', Buffer.alloc(641));
  assert.equal(f.gateways.snapshots()[0].callId, callId);
  assert.equal(f.socket.controls().filter(message => message.type === 'hangup').length, 0);
  f.gateways.receive('desk', f.socket, pcm);
  assert.deepEqual(f.audio, [{ callId, data: pcm }]);
});

for (const state of ['active', 'ended', 'failed']) {
  test(`wrong call-state ID (${state}) cannot affect an owned call`, () => {
    const f = fixture();
    f.active();
    f.control({ type: 'call-state', callId: 'private-other-call', state });
    assert.equal(f.gateways.snapshots()[0].callId, callId);
    assert.equal(f.socket.closed.length, 0);
    assert.equal(f.socket.controls().filter(message => message.type === 'hangup').length, 0);
    assert.deepEqual(f.states.map(event => [event.callId, event.state]), [[callId, 'active']]);
    f.gateways.receive('desk', f.socket, pcm);
    assert.deepEqual(f.audio, [{ callId, data: pcm }]);
  });
}

for (const fault of ['oversized control', 'oversized inbound audio', 'short inbound audio', 'oversized outbound audio', 'audio backpressure', 'invalid JSON'] as const) {
  test(`${fault} shuts down and cleans up only the owned call`, () => {
    const f = fixture();
    f.active();
    const other = new Socket();
    f.connect(true, 'travel', other);
    assert.equal(f.gateways.reserve('travel', 'private-other-call').ok, true);
    if (fault === 'oversized control') f.gateways.receive('desk', f.socket, 'x'.repeat(4097));
    if (fault === 'oversized inbound audio') f.gateways.receive('desk', f.socket, Buffer.alloc(641));
    if (fault === 'short inbound audio') f.gateways.receive('desk', f.socket, Buffer.alloc(639));
    if (fault === 'oversized outbound audio') f.gateways.audio('desk', callId, Buffer.alloc(641));
    if (fault === 'audio backpressure') { f.socket.buffered = 6401; f.gateways.audio('desk', callId, pcm); }
    if (fault === 'invalid JSON') f.gateways.receive('desk', f.socket, '{');
    f.failed();
    assert.deepEqual(f.socket.controls().filter(message => message.type === 'hangup'), [{ type: 'hangup', callId }]);
    assert.equal(f.gateways.snapshots()[1].callId, 'private-other-call');
    assert.equal(other.closed.length, 0);
    assert.equal(other.sent.length, 0);
    f.gateways.expire();
    assert.equal(f.states.filter(event => event.callId === callId && event.state === 'failed').length, 1);
  });
}

test('control backpressure cannot dispatch a dial', () => {
  const f = fixture();
  f.connect();
  assert.equal(f.gateways.reserve('desk', callId).ok, true);
  f.socket.buffered = 6401;
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  assert.equal(f.socket.controls().filter(message => message.type === 'dial').length, 0);
  f.failed();
});

for (const result of [0, false]) {
  test(`a rejected WebSocket send (${result}) fails closed without a dial replay`, () => {
    const f = fixture();
    f.connect();
    assert.equal(f.gateways.reserve('desk', callId).ok, true);
    f.socket.result = result;
    assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
    f.socket.result = 1;
    assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
    f.failed();
  });
}

test('disconnect cleans a call exactly once and late socket input stays inert', () => {
  const f = fixture();
  f.active();
  f.gateways.disconnected('desk', f.socket);
  f.gateways.disconnected('desk', f.socket);
  f.control({ type: 'call-state', callId, state: 'active' });
  f.gateways.receive('desk', f.socket, pcm);
  assert.equal(f.gateways.snapshots()[0].callId, null);
  assert.equal(f.states.filter(event => event.state === 'failed').length, 1);
  assert.equal(f.audio.length, 0);
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
});

test('heartbeat renews freshness, then 45 seconds of silence shuts the call down', () => {
  const f = fixture();
  f.active();
  f.advance(44_000);
  f.control({ type: 'heartbeat' });
  f.advance(45_000);
  f.gateways.expire();
  assert.equal(f.gateways.snapshots()[0].callId, callId);
  f.advance(1);
  f.gateways.expire();
  f.failed();
  assert.deepEqual(f.socket.controls().filter(message => message.type === 'hangup'), [{ type: 'hangup', callId }]);
});

test('replacing a socket cleans its call and stale callbacks cannot touch the new connection', () => {
  const f = fixture();
  f.active();
  const replacement = new Socket();
  f.connect(true, 'desk', replacement);
  assert.ok(f.socket.closed.length > 0);
  assert.equal(f.states.filter(event => event.state === 'failed').length, 1);
  f.gateways.disconnected('desk', f.socket);
  f.control({ type: 'hello', id: 'desk', sampleRate: 16000, ready: false });
  f.gateways.receive('desk', f.socket, pcm);
  assert.equal(f.gateways.snapshots()[0].ready, true);
  assert.equal(f.gateways.reserve('desk', 'new-call').ok, true);
  assert.equal(f.gateways.dial('desk', 'new-call', number, 60).ok, true);
  assert.deepEqual(replacement.controls(), [{ type: 'dial', callId: 'new-call', number, maxSeconds: 60 }]);
});

test('end blocks audio but retains the modem until device-ended confirmation', () => {
  const f = fixture();
  f.active();
  f.gateways.end('desk', callId);
  assert.deepEqual(f.socket.controls().filter(message => message.type === 'hangup'), [{ type: 'hangup', callId }]);
  assert.equal(f.gateways.snapshots()[0].callId, callId);
  assert.equal(f.gateways.snapshots()[0].ready, false);
  assert.equal(f.gateways.reserve('desk', 'next-call').ok, false);
  assert.equal(f.gateways.dial('desk', callId, number, 60).ok, false);
  f.gateways.receive('desk', f.socket, pcm);
  f.gateways.audio('desk', callId, pcm);
  assert.equal(f.audio.length, 0);
  assert.equal(f.socket.frames().length, 0);
  f.control({ type: 'call-state', callId, state: 'ended' });
  assert.equal(f.gateways.snapshots()[0].callId, null);
  assert.equal(f.gateways.reserve('desk', 'next-call').ok, true);
});

test('late active/ringing states cannot reopen audio after a hangup request', () => {
  const f = fixture();
  f.active();
  f.gateways.end('desk', callId);
  for (const state of ['ringing', 'active']) {
    f.control({ type: 'call-state', callId, state });
    f.gateways.receive('desk', f.socket, pcm);
    f.gateways.audio('desk', callId, pcm);
  }
  assert.equal(f.gateways.snapshots()[0].callId, callId);
  assert.equal(f.audio.length, 0);
  assert.equal(f.socket.frames().length, 0);
  assert.deepEqual(f.states.map(event => event.state), ['active']);
  f.control({ type: 'call-state', callId, state: 'ended' });
  assert.equal(f.gateways.snapshots()[0].callId, null);
});

test('an undialled reservation can be cancelled without a hangup', () => {
  const f = fixture();
  f.connect();
  assert.equal(f.gateways.reserve('desk', callId).ok, true);
  f.gateways.end('desk', callId);
  assert.equal(f.gateways.snapshots()[0].callId, null);
  assert.equal(f.socket.sent.length, 0);
  assert.equal(f.gateways.reserve('desk', 'next-call').ok, true);
});
