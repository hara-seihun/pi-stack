import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const page = readFileSync(new URL('./media.html', import.meta.url), 'utf8');
const worklet = page.match(/<script id="telephone-worklet" type="text\/plain">([\s\S]*?)<\/script>/)![1];
const client = page.match(/<script type="module">([\s\S]*?)<\/script>/)![1];

function processor() {
  const packets: { pcm: ArrayBuffer; time: number }[] = [];
  const context = vm.createContext({
    sampleRate: 48000, currentFrame: 0,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (packet: { pcm: ArrayBuffer; time: number }) => packets.push(packet) };
    },
    registerProcessor: () => {},
  });
  vm.runInContext(worklet + ';globalThis.processor = new TelephoneAudio()', context);
  return { context, node: context.processor, packets };
}

function render(frequency: number, seconds = 1) {
  const state = processor();
  const rendered: number[] = [];
  for (let frame = 0; frame < 48000 * seconds; frame += 128) {
    state.context.currentFrame = frame;
    const input = Float32Array.from({ length: 128 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * (frame + i) / 48000));
    const output = new Float32Array(128);
    state.node.process([[input]], [[output]]);
    rendered.push(...output);
  }
  const pcm = state.packets.flatMap(({ pcm }) => {
    assert.equal(pcm.byteLength, 640);
    const view = new DataView(pcm);
    return Array.from({ length: 320 }, (_, i) => view.getInt16(i * 2, true) / 32768);
  });
  return { ...state, rendered, pcm };
}

function rms(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

test('remote audio is 16 kHz PCM in 20 ms frames, without looping into the outgoing track', () => {
  const { packets, pcm, rendered } = render(1000);
  assert.equal(packets.length, 50);
  assert.equal(pcm.length, 16000);
  assert.ok(Math.abs(rms(pcm.slice(100)) - Math.SQRT1_2 / 2) < 0.002);
  const crossings = pcm.slice(100).filter((sample, i) => sample > 0 && pcm[i + 99] <= 0).length;
  assert.ok(Math.abs(crossings - 994) <= 2);
  assert.equal(rms(rendered), 0);
  for (let i = 1; i < packets.length; i++) assert.ok(Math.abs(packets[i].time - packets[i - 1].time - 0.02) < 128 / 48000);
});

test('decimation removes frequencies above the telephone Nyquist frequency', () => {
  assert.ok(rms(render(12000).pcm.slice(100)) < 0.001);
});

test('telephone input is little-endian, interpolated at 48 kHz, and queue-bounded', () => {
  const { node } = processor();
  const packet = new ArrayBuffer(640);
  const view = new DataView(packet);
  for (let i = 0; i < 320; i++) view.setInt16(i * 2, 8192, true);
  for (let i = 0; i < 20; i++) node.port.onmessage({ data: packet });
  assert.equal(node.count, 3200);
  const output = new Float32Array(128);
  node.process([[]], [[output]]);
  assert.ok(output.every(value => value === 0.25));
  for (let i = 0; i < 100; i++) node.process([[]], [[output]]);
  assert.ok(output.every(value => value === 0));
  assert.ok(node.count < 2);
});

async function browser() {
  const sends: (string | ArrayBuffer)[] = [];
  const requests: { url: string; options: any }[] = [];
  const intervals: (() => void)[] = [];
  const tracks = [{ stop() {}, contentHint: '' }];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const context = vm.createContext({
    document: { getElementById: (id: string) => id === 'status' ? {} : { textContent: worklet } },
    location: { hash: '#test-token', pathname: '/media', search: '', href: 'http://localhost:8799/media#test-token', protocol: 'http:' },
    history: { replaceState() {} }, window: { addEventListener() {} },
    URL, Blob, AbortController, crypto: { randomUUID: () => 'test-event' },
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; },
    clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    fetch: async (url: string, options: any) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ session: { id: 'live-session' }, transport: { sdp: 'answer' } }) };
    },
    AudioContext: class {
      state = 'running'; currentTime = 0;
      audioWorklet = { addModule: async () => {} };
      destination = {};
      createMediaStreamDestination() { return { stream }; }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async resume() {}
      async close() { this.state = 'closed'; }
    },
    Audio: class { volume = 1; srcObject = null; async play() {} pause() {} },
    MediaStream: class { constructor(_tracks: any[]) {} },
    AudioWorkletNode: class { port = { onmessage: null, postMessage() {}, close() {} }; connect() {} disconnect() {} },
    RTCPeerConnection: class {
      iceGatheringState = 'complete'; localDescription = { sdp: 'offer' }; connectionState = 'connected';
      addTrack() {}
      createDataChannel(name: string) {
        assert.equal(name, 'oai-events');
        return { readyState: 'open', send: (value: string) => { context.liveSends.push(JSON.parse(value)); }, close() {} };
      }
      async createOffer() { return { type: 'offer', sdp: 'offer' }; }
      async setLocalDescription() {}
      async setRemoteDescription(value: any) { assert.equal(value.sdp, 'answer'); }
      close() {}
    },
    WebSocket: class {
      static OPEN = 1;
      readyState = 1; bufferedAmount = 0;
      constructor(url: URL) { assert.equal(url.href, 'ws://localhost:8799/browser-media'); }
      send(value: string | ArrayBuffer) { sends.push(value); }
      close() { this.readyState = 3; }
    },
    liveSends: [],
  });
  vm.runInContext(client, context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext('socket.onopen()', context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, sends, requests, intervals };
}

test('browser authenticates first, negotiates locally, forwards transcripts and waits for session.started', async () => {
  const { context, sends, requests } = await browser();
  assert.deepEqual(JSON.parse(sends[0] as string), { type: 'authenticate', token: 'test-token' });
  assert.equal(requests[0].url, '/media/offer');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(requests[0].options.body), { sdp: 'offer' });
  vm.runInContext(`socket.onmessage({data:JSON.stringify({type:'context',text:'Context before ready'})})`, context);
  assert.equal(context.liveSends.length, 0);
  vm.runInContext(`channel.onmessage({data:JSON.stringify({type:'session.started'})});
    channel.onmessage({data:JSON.stringify({type:'session.input_transcript.delta',delta:'Hello',start_ms:0,end_ms:100})})`, context);
  const messages = sends.map(value => JSON.parse(value as string));
  assert.equal(messages.filter(message => message.type === 'ready').length, 1);
  assert.equal(messages.at(-1).event.delta, 'Hello');
  assert.equal(context.liveSends[0].type, 'session.commentary.append');
  assert.equal(context.liveSends[0].content, 'Context before ready');
  vm.runInContext(`socket.onmessage({data:'{"type":"close"}'})`, context);
  assert.equal(vm.runInContext('closed && audio.state === "closed"', context), true);
});

test('output is paced, queue-bounded, stale audio discarded, websocket backpressure is fatal', async () => {
  const { context, sends, intervals } = await browser();
  vm.runInContext(`channel.onmessage({data:'{"type":"session.started"}'});
    for(let i=0;i<20;i++) bridge.port.onmessage({data:{pcm:new ArrayBuffer(640),time:0}})`, context);
  assert.equal(vm.runInContext('outgoing.length', context), 5);
  intervals[0]();
  assert.equal(sends.filter(value => typeof value !== 'string').length, 1);
  vm.runInContext('audio.currentTime = 1', context);
  intervals[0]();
  assert.equal(sends.filter(value => typeof value !== 'string').length, 1);
  vm.runInContext('bridge.port.onmessage({data:{pcm:new ArrayBuffer(640),time:1}});socket.bufferedAmount=10000', context);
  intervals[0]();
  assert.equal(JSON.parse(sends.at(-1) as string).type, 'error');
  assert.equal(vm.runInContext('closed', context), true);
});
