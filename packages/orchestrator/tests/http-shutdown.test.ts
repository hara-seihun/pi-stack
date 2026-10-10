import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { once } from 'node:events';
import { test } from 'vitest';
import { closeHttpServer } from '../src/http-shutdown.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

test('completed requests drain without connection retirement; invalid budgets do not close the listener', async () => {
  const server = createServer((_request, response) => response.end('ready'));
  const port = await listen(server);
  const invalid = await closeHttpServer(server, 0);
  assert.equal(invalid.ok, false);
  if (invalid.ok) throw new Error('Invalid budget was accepted');
  assert.equal(invalid.error.code, 'invalid-budget');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready');
  assert.deepEqual(await closeHttpServer(server, 100), { ok: true, value: 'drained' });
});

test('unfinished request bodies and accepted responses cannot hold controller shutdown hostage', async () => {
  for (const kind of ['partial-body', 'accepted-response']) {
    const accepted = new Map<string, string>();
    let observe!: () => void;
    const received = new Promise<void>(resolve => { observe = resolve; });
    const server = createServer((request, _response) => {
      if (kind === 'accepted-response') accepted.set('original-request', 'original-message');
      request.on('error', () => {});
      observe();
    });
    const port = await listen(server);
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(kind === 'partial-body'
      ? 'POST /send HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx'
      : 'GET /send HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await received;
    const started = performance.now();
    assert.deepEqual(await closeHttpServer(server, 25), { ok: true, value: 'connections-retired' });
    assert.ok(performance.now() - started < 1_000);
    assert.equal(accepted.get('original-request'), kind === 'accepted-response' ? 'original-message' : undefined);
    socket.destroy();
  }
});
