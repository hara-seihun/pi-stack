import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const page = readFileSync(new URL('./media.html', import.meta.url), 'utf8');
const client = page.match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^import .*;$/m, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function browser(options: { takeoverFails?: boolean; deferTakeover?: boolean; gateway?: boolean } = {}) {
  const sends: any[] = [], liveSends: any[] = [], requests: { url: string; body: any }[] = [];
  const clones: { stopped: boolean }[] = [];
  let releaseTakeover: () => void = () => {};
  const takeover = options.deferTakeover ? new Promise<void>(resolve => { releaseTakeover = resolve; }) : Promise.resolve();
  const originalTrack = { id: 'caller-audio', kind: 'audio', readyState: 'live', stopped: false, stop() { this.stopped = true; }, clone() { const track = { kind: 'audio', readyState: 'live', stopped: false, stop() { this.stopped = true; } }; clones.push(track); return track; } };
  const nativeCapture = async (_constraints: unknown): Promise<any> => { throw new Error('Hardware microphone must not be requested'); };
  const devices = { getUserMedia: nativeCapture };
  const room = { remoteParticipants: new Map([['caller', { trackPublications: new Map([['caller', { trackName: 'user_audio', track: { sid: 'caller', kind: 'audio', mediaStreamTrack: originalTrack, setVolume() {} } }]]) }]]), on() {}, off() {} };
  const gatewayAudio = { muted: false };
  const gatewayPeer = { getReceivers: () => [{ track: originalTrack }], addEventListener() {} };
  const context = vm.createContext({
    document: { getElementById: () => ({ textContent: '' }) },
    location: { origin: 'http://localhost:8799', hash: '#test-token', pathname: '/media', search: '', href: 'http://localhost:8799/media#test-token', protocol: 'http:' },
    history: { replaceState() {} }, window: { addEventListener() {} }, navigator: { mediaDevices: devices },
    URL, Response, AbortController, crypto: { randomUUID: () => 'test-event' },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: async (url: string, init: any) => {
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      requests.push({ url, body: JSON.parse(init.body) });
      if (url === '/media/offer') return Response.json({ session: { id: 'voice' }, transport: { sdp: 'answer' } });
      if (url === '/media/transport') return Response.json(options.gateway
        ? { callId: 'call-1', accessToken: 'join-token', participantId: 'monitor-1', transport: 'gateway' }
        : { callId: 'call-1', accessToken: 'join-token', participantId: 'monitor-1', url: 'wss://test.livekit.cloud', transport: 'livekit' });
      if (url === '/media/takeover') {
        await takeover;
        return options.takeoverFails ? new Response('denied', { status: 409 }) : Response.json({ takenOver: true });
      }
      throw new Error('Unexpected request ' + url);
    },
    AudioContext: class {
      state = 'running'; destination = {};
      sampleRate = 48000;
      createMediaStreamDestination() { const track = { ...originalTrack, id: 'gated-output', contentHint: '' }; return { stream: { getTracks: () => [track], getAudioTracks: () => [track] } }; }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 8, frequencyBinCount: 1024, connect() {}, disconnect() {}, getFloatTimeDomainData(data: Float32Array) { data.fill(0.1); }, getFloatFrequencyData(data: Float32Array) { data.fill(-60); } }; }
      async resume() {}
      async close() { this.state = 'closed'; }
    },
    Audio: class { volume = 1; srcObject = null; async play() {} pause() {} },
    MediaStream: class {
      constructor(public tracks: any[]) {}
      getAudioTracks() { return this.tracks; }
      getTracks() { return this.tracks; }
    },
    RTCPeerConnection: class {
      iceGatheringState = 'complete'; localDescription = { sdp: 'offer' }; connectionState = 'connected'; ontrack?: (event: any) => void;
      addTrack() {}
      createDataChannel(name: string) {
        assert.equal(name, 'oai-events');
        return { readyState: 'open', send: (value: string) => liveSends.push(JSON.parse(value)), close() {} };
      }
      async createOffer() { return { type: 'offer', sdp: 'offer' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { this.ontrack?.({ track: originalTrack }); }
      close() {}
    },
    WebSocket: class {
      static OPEN = 1; readyState = 1;
      constructor(url: URL) { assert.equal(url.href, 'ws://localhost:8799/browser-media'); }
      send(value: string) { assert.equal(typeof value, 'string'); sends.push(JSON.parse(value)); }
      close() { this.readyState = 3; }
    },
    RoomEvent: { TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed' }, Track: { Kind: { Audio: 'audio' } },
    RetellClient: class {
      constructor(public config: any) { assert.equal(config.key, 'test-token'); }
      monitorCall(config: any) {
        assert.equal(config.transcript, false);
        const api = this.config.fetch;
        const monitor = {
          ready: Promise.resolve(), status: 'monitoring', transport: options.gateway ? { pc: gatewayPeer, audioEl: gatewayAudio, dc: { onmessage() {} } } : { room },
          async listen() { const response = await api('http://localhost:8799/v2/listen-live-call/call-1', { method: 'POST', body: '{}' }); assert.equal((await response.json()).access_token, 'join-token'); this.status = 'listening'; },
          async takeOver() {
            const probe = await devices.getUserMedia({ audio: true } as never) as any;
            try {
              await api('http://localhost:8799/v2/take-over-live-call/call-1', { method: 'POST', body: '{"participant_id":"monitor-1"}' });
              const stream = await devices.getUserMedia({ audio: true } as never) as any;
              (this as any).publication = stream.getAudioTracks()[0];
              this.status = 'taken_over';
            } finally { probe.getTracks().forEach((track: any) => track.stop()); }
          },
          disconnect() { (this as any).publication?.stop(); this.status = 'ended'; },
        };
        return monitor;
      }
    },
  });
  vm.runInContext(client, context);
  await tick();
  vm.runInContext('socket.onopen()', context);
  await tick();
  vm.runInContext(`channel.onmessage({data:'{"type":"session.started"}'})`, context);
  await tick();
  const control = (value: unknown) => { context.controlPayload = JSON.stringify(value); vm.runInContext('socket.onmessage({data:controlPayload})', context); };
  return { context, sends, liveSends, requests, clones, devices, nativeCapture, originalTrack, gatewayAudio, releaseTakeover, control };
}

test('voice ready precedes dial, opening is gated by successful permanent takeover, capture is restored', async () => {
  const state = await browser({ deferTakeover: true });
  assert.deepEqual(state.sends[0], { type: 'authenticate', token: 'test-token' });
  assert.equal(state.sends.filter(value => value.type === 'ready').length, 1);
  assert.deepEqual(state.requests.map(value => value.url), ['/media/offer']);
  state.control({ type: 'context', text: 'Approved opening' });
  state.control({ type: 'transport', callId: 'call-1' });
  await tick();
  assert.equal(state.liveSends.length, 0);
  assert.equal(state.sends.some(value => value.type === 'transport-ready'), false);
  assert.notEqual(state.devices.getUserMedia, state.nativeCapture);
  state.releaseTakeover();
  await tick();
  assert.deepEqual(state.requests.at(-1), { url: '/media/takeover', body: { callId: 'call-1', participantId: 'monitor-1' } });
  assert.deepEqual(state.sends.at(-1), { type: 'transport-ready', callId: 'call-1', participantId: 'monitor-1' });
  assert.equal(state.liveSends[0].content, 'Approved opening');
  assert.equal(state.devices.getUserMedia, state.nativeCapture);
  assert.equal(state.clones.length, 2);
  assert.equal(state.clones[0].stopped, true);
  assert.equal(state.clones[1].stopped, false);
  assert.equal(state.originalTrack.stopped, false);
  vm.runInContext('observeOutput()', state.context);
  assert.equal(state.sends.some(value => value.type === 'audio-proof'), false, 'Opening audio stays muted during the greeting');
  assert.equal(vm.runInContext('outputGate.gain.value', state.context), 0);
  state.control({ type: 'playout', enabled: true });
  vm.runInContext('observeOutput()', state.context);
  assert.equal(state.sends.at(-1).type, 'audio-proof');
  state.control({ type: 'close' });
  assert.equal(state.clones[1].stopped, true);
  assert.equal(state.originalTrack.stopped, false);
  assert.equal(vm.runInContext('closed && audio.state === "closed"', state.context), true);
});

test('gateway grants without a LiveKit URL route caller audio and gate the opening on permanent takeover', async () => {
  const state = await browser({ gateway: true, deferTakeover: true });
  state.control({ type: 'context', text: 'Approved opening' });
  state.control({ type: 'transport', callId: 'call-1' });
  await tick();
  assert.equal(vm.runInContext('incoming.size', state.context), 1);
  assert.equal(state.gatewayAudio.muted, true);
  assert.equal(state.liveSends.length, 0);
  assert.equal(state.sends.some(value => value.type === 'transport-ready'), false);
  state.releaseTakeover();
  await tick();
  assert.deepEqual(state.requests.at(-1), { url: '/media/takeover', body: { callId: 'call-1', participantId: 'monitor-1' } });
  assert.deepEqual(state.sends.at(-1), { type: 'transport-ready', callId: 'call-1', participantId: 'monitor-1' });
  assert.equal(state.liveSends[0].content, 'Approved opening');
  assert.equal(state.devices.getUserMedia, state.nativeCapture);
  state.control({ type: 'close' });
  assert.equal(state.clones[1].stopped, true);
  assert.equal(vm.runInContext('closed && audio.state === "closed"', state.context), true);
});

test('failed takeover does not release the opening or leave a capture override', async () => {
  const state = await browser({ takeoverFails: true });
  state.control({ type: 'context', text: 'Do not speak this before takeover' });
  state.control({ type: 'transport', callId: 'call-1' });
  await tick();
  assert.equal(state.devices.getUserMedia, state.nativeCapture);
  assert.equal(state.sends.some(value => value.type === 'transport-ready'), false);
  assert.equal(state.liveSends.some(value => value.type === 'session.commentary.append'), false);
  assert.equal(state.sends.at(-1).type, 'error');
  assert.match(state.sends.at(-1).error, /takeover failed/);
  assert.equal(vm.runInContext('closed', state.context), true);
});

test('audio-only preflight measures native output without obtaining any PSTN grant', async () => {
  const state = await browser();
  state.control({ type: 'preflight', text: 'Audio-only preflight: speak the approved opening.' });
  vm.runInContext('observeOutput()', state.context);
  assert.equal(state.liveSends[0].type, 'session.commentary.append');
  assert.equal(state.sends.at(-1).type, 'audio-proof');
  assert.ok(state.sends.at(-1).bytes > 0);
  assert.deepEqual(state.requests.map(value => value.url), ['/media/offer']);
  assert.equal(state.devices.getUserMedia, state.nativeCapture);
  state.control({ type: 'transport', callId: 'call-1' });
  await tick();
  assert.equal(state.sends.at(-1).type, 'error');
  assert.equal(vm.runInContext('closed', state.context), true);
});
