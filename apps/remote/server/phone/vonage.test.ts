import { strict as assert } from 'node:assert';
import { createHash, createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { signedWebhook, Vonage, type Credentials } from './vonage.ts';

const secret = 'synthetic-test-signature-secret';
const now = 1_790_000_000_000;
const claims = { iat: now / 1000, exp: now / 1000 + 120 };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(payload: unknown = claims, key = secret, header: unknown = { alg: 'HS256', typ: 'JWT' }) {
  const data = `${encode(header)}.${encode(payload)}`;
  return `Bearer ${data}.${createHmac('sha256', key).update(data).digest('base64url')}`;
}

test('signed webhooks accept authentic, fresh HS256 claims', () => {
  assert.equal(signedWebhook(token(), secret, now), true);
  assert.equal(signedWebhook(token({ iat: claims.iat }), secret, now), true);
  for (const offset of [-300, 300]) {
    assert.equal(signedWebhook(token({ iat: claims.iat + offset }), secret, now), true);
  }
});

test('signed webhooks reject wrong keys, tampered payloads and signatures', () => {
  assert.equal(signedWebhook(token(), 'wrong-secret', now), false);
  assert.equal(signedWebhook(token(claims, 'wrong-secret'), secret, now), false);
  const authentic = token().slice(7).split('.');
  const tampered = `Bearer ${authentic[0]}.${encode({ ...claims, injected: true })}.${authentic[2]}`;
  assert.equal(signedWebhook(tampered, secret, now), false);
  const signature = Buffer.from(authentic[2], 'base64url');
  signature[0] ^= 1;
  assert.equal(signedWebhook(`Bearer ${authentic[0]}.${authentic[1]}.${signature.toString('base64url')}`, secret, now), false);
});

test('signed webhooks reject algorithm confusion even with a valid HMAC', () => {
  for (const alg of ['none', 'HS384', 'HS512', 'RS256', 'hs256', undefined]) {
    assert.equal(signedWebhook(token(claims, secret, { alg }), secret, now), false, String(alg));
  }
});

test('signed webhooks reject stale, future, expired and invalid issued-at claims', () => {
  for (const iat of [claims.iat - 301, claims.iat + 301, undefined, null, String(claims.iat), 'not-a-time']) {
    assert.equal(signedWebhook(token({ iat }), secret, now), false, String(iat));
  }
  assert.equal(signedWebhook(token({ ...claims, exp: claims.iat - 1 }), secret, now), false);
});

test('signed webhooks reject malformed authorization and JWT structures without throwing', () => {
  for (const header of [null, '', token().slice(7), token().replace('Bearer ', 'Basic '), 'Bearer ', 'Bearer a.b', 'Bearer a.b.c.d', 'Bearer a.b.c', `${token()}.extra`, `${token().slice(0, token().lastIndexOf('.') + 1)}AA`, token(null), token(claims, secret, null)]) {
    assert.equal(signedWebhook(header, secret, now), false, String(header));
  }
});

test('signed webhooks bind the signature to the exact raw request body', () => {
  const body = JSON.stringify({ uuid: 'call-123', status: 'completed' });
  const payload_hash = createHash('sha256').update(body).digest('hex');
  const signed = token({ ...claims, payload_hash });
  assert.equal(signedWebhook(signed, secret, now, body), true);
  assert.equal(signedWebhook(signed, secret, now, body.replace('completed', 'failed')), false);
  assert.equal(signedWebhook(signed, secret, now, `${body}\n`), false);
  assert.equal(signedWebhook(token(), secret, now, body), false);
  assert.equal(signedWebhook(token({ ...claims, payload_hash: 'wrong-hash' }), secret, now, body), false);
  assert.equal(signedWebhook(token({ ...claims, payload_hash: 123 }), secret, now, body), false);
});

test('provider sends scoped RS256 authentication and correct dial/hangup requests without network calls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-phone-vonage-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials: Credentials = {
    VONAGE_APPLICATION_ID: 'test-application',
    VONAGE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    VONAGE_SIGNATURE_SECRET: secret,
    VONAGE_FROM_NUMBER: '+442079460000',
  };
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify(credentials), { mode: 0o600 });
  const provider = new Vonage(path);
  const requests: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return options.method === 'PUT' ? new Response(null, { status: 204 }) : Response.json({ uuid: 'call-123', status: 'started' });
  });
  const ncco = [{ action: 'talk', text: 'Approved introduction' }];
  assert.deepEqual(await provider.dial('+442079460123', ncco, 'https://phone.example/vonage/events/test'), { ok: true, value: { uuid: 'call-123', status: 'started' } });
  const dial = requests[0];
  assert.equal(dial.url, 'https://api.nexmo.com/v1/calls');
  assert.equal(dial.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(dial.options.body)), {
    to: [{ type: 'phone', number: '442079460123' }],
    from: { type: 'phone', number: '442079460000' },
    ncco,
    event_url: ['https://phone.example/vonage/events/test'],
    event_method: 'POST',
  });
  const bearer = new Headers(dial.options.headers).get('authorization')!;
  const [header, payload, signature] = bearer.slice(7).split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
  const jwt = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(jwt.application_id, credentials.VONAGE_APPLICATION_ID);
  assert.equal(jwt.exp - jwt.iat, 120);
  assert.ok(jwt.jti);
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.ok(!JSON.stringify(dial.options).includes(secret));
  assert.ok(!JSON.stringify(dial.options).includes('PRIVATE KEY'));
  assert.deepEqual(await provider.hangup('call/with?reserved'), { ok: true, value: {} });
  assert.equal(requests[1].url, 'https://api.nexmo.com/v1/calls/call%2Fwith%3Freserved');
  assert.equal(requests[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requests[1].options.body)), { action: 'hangup' });
});
