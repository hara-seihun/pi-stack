import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import test from 'node:test';
import { admissionExpression, inspectorEvaluate, isOriginalBrokerUnit } from '../deploy/core-broker-handoff.mjs';

test('registered per-person broker unit binds its exact original config', () => {
  const user = 'pi5381e24743c0d8b3dcf0f3a4';
  assert.equal(isOriginalBrokerUnit(`pi-stack-model-broker@${user}.service`, `/var/lib/pi-stack-oidc/brokers/${user}.json`), true);
  assert.equal(isOriginalBrokerUnit(`pi-stack-model-broker@${user}.service`, '/var/lib/pi-stack-oidc/brokers/other.json'), false);
  assert.equal(isOriginalBrokerUnit('arbitrary.service', '/var/lib/pi-stack-oidc/brokers/other.json'), false);
  assert.equal(isOriginalBrokerUnit('pi-model-broker.service', '/declared-original.json'), true);
});

const program = `const http=require('node:http');let long;let late=0;const server=http.createServer((req,res)=>{if(req.url==='/long'){long=res;process.send({accepted:true});}else{late++;res.end('unexpected late admission');}});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));process.on('message',message=>{if(message.finish){long.end('original accepted result');process.send({late});}});setInterval(()=>{},1000);`;
test('owned broker admission closes only future requests and positively drains accepted HTTP', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '-e', program], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let client;
  try {
    const endpoint = await new Promise((accept, reject) => {
      child.stderr.on('data', data => { const match = /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.exec(String(data)); if (match) accept(match[0]); });
      child.once('error', reject);
    });
    const [{ port }] = await once(child, 'message');
    client = createConnection({ host: '127.0.0.1', port });
    await once(client, 'connect');
    const accepted = once(child, 'message');
    client.write('GET /long HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await accepted;
    const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/);
    const identity = { pid: child.pid, uid: process.getuid(), startTicks: fields[19], id: 'synthetic-owned-handoff' };
    await assert.rejects(inspectorEvaluate(endpoint, admissionExpression(identity, [port + 1])));
    const armed = await inspectorEvaluate(endpoint, admissionExpression(identity, [port]));
    assert.equal(armed.state, 'draining');
    assert.equal(armed.drainedAt, null);
    let response = '';
    client.on('data', data => { response += data; });
    const closed = once(client, 'close');
    client.write('GET /late HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    const counted = once(child, 'message');
    child.send({ finish: true });
    const [count] = await counted;
    assert.equal(count.late, 0);
    await closed;
    assert.match(response, /original accepted result/);
    assert.match(response, /503 Service Unavailable/);
    const drained = await inspectorEvaluate(endpoint, admissionExpression(identity, [port]));
    assert.equal(drained.state, 'drained');
    assert.ok(drained.drainedAt);
    const pid = await inspectorEvaluate(endpoint, 'process.pid');
    assert.equal(pid, child.pid);
    await assert.rejects(inspectorEvaluate(endpoint, admissionExpression({ ...identity, id: 'different-purpose' }, [port])));
  } finally {
    client?.destroy();
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
