import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

// PI_PHONE_TEST_CHROMIUM=/path/to/chrome bun test server/phone/media.browser.test.ts
const mockSdk = `
export const RoomEvent = { TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed' };
export const Track = { Kind: { Audio: 'audio' } };
export class RetellClient {
  constructor(config) { this.config = config; }
  monitorCall(options) {
    const fetch = this.config.fetch;
    const state = window.testAudio;
    const room = { on() {}, off() {}, remoteParticipants: new Map() };
    return {
      ready: Promise.resolve(), status: 'monitoring', transport: { room },
      async listen() {
        await fetch('http://127.0.0.1:8802/v2/listen-live-call/synthetic-call', {method:'POST',body:'{}'});
        const context = state.context;
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 440;
        const input = context.createMediaStreamDestination();
        oscillator.connect(input); oscillator.start();
        const track = { sid: 'caller', kind: 'audio', mediaStreamTrack: input.stream.getAudioTracks()[0], setVolume() {} };
        room.remoteParticipants.set('caller', { trackPublications: new Map([['caller', {trackName:'user_audio', track}]]) });
        this.status = 'listening';
      },
      async takeOver() {
        const probe = await navigator.mediaDevices.getUserMedia({audio:true});
        try {
          await fetch('http://127.0.0.1:8802/v2/take-over-live-call/synthetic-call', {method:'POST',body:'{"participant_id":"monitor"}'});
          this.stream = await navigator.mediaDevices.getUserMedia({audio:true});
          state.measure(this.stream, 'telephoneOutput');
          this.status = 'taken_over';
        } finally { probe.getTracks().forEach(track => track.stop()); }
      },
      disconnect() { this.stream?.getTracks().forEach(track => track.stop()); this.status = 'ended'; }
    };
  }
}
`;

test('native WebRTC duplex sends GPT audio to the telephone and only caller audio back to GPT', { skip: !process.env.PI_PHONE_TEST_CHROMIUM, timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PI_PHONE_TEST_CHROMIUM, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8802/media', route => route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('./media.html', import.meta.url), 'utf8') }));
    await page.route('http://127.0.0.1:8802/media/retell-sdk.js', route => route.fulfill({ contentType: 'text/javascript', body: mockSdk }));
    await page.addInitScript(() => {
      const context = new AudioContext({ sampleRate: 48000 });
      const state = (window as any).testAudio = { context, ready: false, takenOver: false, proof: false, error: '', callerInput: { low: 0, high: 0 }, telephoneOutput: { low: 0, high: 0 }, requests: [] as string[], nativeCapture: navigator.mediaDevices.getUserMedia };
      state.measure = (stream: MediaStream, name: string) => {
        const playback = new Audio(); playback.volume = 0; playback.srcObject = stream; void playback.play();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser(); analyser.fftSize = 4096;
        const muted = context.createGain(); muted.gain.value = 0;
        source.connect(analyser); analyser.connect(muted); muted.connect(context.destination);
        const frequencies = new Float32Array(analyser.frequencyBinCount);
        const measure = () => {
          analyser.getFloatFrequencyData(frequencies);
          const bin = (frequency: number) => frequencies[Math.round(frequency * analyser.fftSize / context.sampleRate)];
          state[name] = { low: bin(440), high: bin(1000) };
          requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      };
      (window as any).WebSocket = class {
        static OPEN = 1; readyState = 1;
        onopen?: () => void; onmessage?: (event: { data: string }) => void;
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        send(value: string) {
          if (typeof value !== 'string') throw new Error('Control websocket must not contain audio');
          const message = JSON.parse(value);
          if (message.type === 'ready') { state.ready = true; setTimeout(() => this.onmessage?.({ data: '{"type":"transport","callId":"synthetic-call"}' }), 0); }
          if (message.type === 'transport-ready') state.takenOver = true;
          if (message.type === 'audio-proof') state.proof = true;
          if (message.type === 'error') state.error = message.error;
        }
        close() { this.readyState = 3; }
      };
      (window as any).fetch = async (url: string, options: RequestInit) => {
        state.requests.push(url);
        if (url === '/media/transport') return Response.json({ callId: 'synthetic-call', accessToken: 'join', participantId: 'monitor', transport: 'livekit', url: 'wss://synthetic.livekit.cloud' });
        if (url === '/media/takeover') return Response.json({ takenOver: true });
        if (url !== '/media/offer') throw new Error('Unexpected route');
        const remote = new RTCPeerConnection();
        const oscillator = context.createOscillator(); oscillator.frequency.value = 1000;
        const output = context.createMediaStreamDestination(); oscillator.connect(output); oscillator.start();
        remote.ondatachannel = ({ channel }) => { channel.onopen = () => channel.send('{"type":"session.started"}'); };
        remote.ontrack = ({ track }) => state.measure(new MediaStream([track]), 'callerInput');
        await remote.setRemoteDescription({ type: 'offer', sdp: JSON.parse(String(options.body)).sdp });
        remote.addTrack(output.stream.getAudioTracks()[0], output.stream);
        await remote.setLocalDescription(await remote.createAnswer());
        if (remote.iceGatheringState !== 'complete') await new Promise<void>(resolve => { remote.onicegatheringstatechange = () => { if (remote.iceGatheringState === 'complete') resolve(); }; });
        await context.resume();
        return Response.json({ session: { id: 'synthetic' }, transport: { sdp: remote.localDescription!.sdp } });
      };
    });
    await page.goto('http://127.0.0.1:8802/media#synthetic-token');
    await page.waitForFunction(() => {
      const state = (window as any).testAudio;
      return state.error || (state.takenOver && state.proof && state.callerInput.low > -30 && state.telephoneOutput.high > -30);
    }, null, { timeout: 10000 });
    const result = await page.evaluate(() => {
      const state = (window as any).testAudio;
      return { error: state.error, ready: state.ready, takenOver: state.takenOver, proof: state.proof, callerInput: state.callerInput, telephoneOutput: state.telephoneOutput, restored: navigator.mediaDevices.getUserMedia === state.nativeCapture, requests: state.requests };
    });
    assert.equal(result.error, '');
    assert.equal(result.ready, true);
    assert.equal(result.takenOver, true);
    assert.equal(result.proof, true);
    assert.equal(result.restored, true);
    assert.ok(result.callerInput.low > result.callerInput.high + 20, 'Only caller tone returns into GPT microphone');
    assert.ok(result.telephoneOutput.high > result.telephoneOutput.low + 20, 'Only GPT tone is published to the telephone');
    assert.deepEqual(result.requests, ['/media/offer', '/media/transport', '/media/takeover']);
  } finally { await browser.close(); }
});
