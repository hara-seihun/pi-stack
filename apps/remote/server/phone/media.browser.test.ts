import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

// PI_PHONE_TEST_CHROMIUM=/path/to/chrome bun test server/phone/media.browser.test.ts
// A synthetic WebRTC peer exercises Chromium's real receive/playout path without a billed session or call.
test('headless Chromium forwards native WebRTC audio as PCM without feeding it back', { skip: !process.env.PI_PHONE_TEST_CHROMIUM, timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PI_PHONE_TEST_CHROMIUM, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8802/media', route => route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('./media.html', import.meta.url), 'utf8') }));
    await page.addInitScript(() => {
      const state = (window as any).testAudio = { packets: 0, peak: 0, ready: false, feedback: 0, error: '' };
      (window as any).WebSocket = class {
        static OPEN = 1;
        readyState = 1; bufferedAmount = 0;
        onopen?: () => void;
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        send(value: string | ArrayBuffer) {
          if (typeof value === 'string') {
            const message = JSON.parse(value);
            if (message.type === 'ready') state.ready = true;
            if (message.type === 'error') state.error = message.error;
          } else {
            state.packets++;
            const pcm = new DataView(value);
            for (let i = 0; i < pcm.byteLength; i += 2) state.peak = Math.max(state.peak, Math.abs(pcm.getInt16(i, true)));
          }
        }
        close() { this.readyState = 3; }
      };
      (window as any).fetch = async (_url: RequestInfo | URL, options?: RequestInit) => {
        const remote = new RTCPeerConnection();
        const audio = new AudioContext({ sampleRate: 48000 });
        const oscillator = audio.createOscillator();
        oscillator.frequency.value = 1000;
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        remote.ondatachannel = ({ channel }) => {
          channel.onopen = () => channel.send(JSON.stringify({ type: 'session.started' }));
        };
        remote.ontrack = ({ track }) => {
          const stream = new MediaStream([track]);
          const playback = new Audio();
          playback.volume = 0;
          playback.srcObject = stream;
          void playback.play();
          const receiver = audio.createMediaStreamSource(stream);
          const analyser = audio.createAnalyser();
          receiver.connect(analyser);
          const muted = audio.createGain();
          muted.gain.value = 0;
          analyser.connect(muted);
          muted.connect(audio.destination);
          setInterval(() => {
            const samples = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(samples);
            for (const sample of samples) state.feedback = Math.max(state.feedback, Math.abs(sample));
          }, 20);
        };
        await remote.setRemoteDescription({ type: 'offer', sdp: JSON.parse(String(options!.body)).sdp });
        remote.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
        await remote.setLocalDescription(await remote.createAnswer());
        if (remote.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
          remote.onicegatheringstatechange = () => { if (remote.iceGatheringState === 'complete') resolve(); };
        });
        await audio.resume();
        return Response.json({ session: { id: 'synthetic' }, transport: { sdp: remote.localDescription!.sdp } });
      };
    });
    await page.goto('http://127.0.0.1:8802/media#synthetic-token');
    await page.waitForFunction(() => (window as any).testAudio.peak > 1000 || (window as any).testAudio.error, null, { timeout: 10000 }).catch(async () => {
      throw new Error(JSON.stringify(await page.evaluate(() => ({ state: (window as any).testAudio, diagnostics: (window as any).telephoneMediaDiagnostics(), status: document.getElementById('status')!.textContent }))));
    });
    const result = await page.evaluate(() => ({ ...(window as any).testAudio, diagnostics: (window as any).telephoneMediaDiagnostics() }));
    assert.equal(result.error, '');
    assert.equal(result.ready, true);
    assert.ok(result.peak > 1000, 'Chromium must actually play the remote stream into the worklet');
    assert.ok(result.feedback < 0.001, 'Remote audio must not return over the outgoing WebRTC track');
    assert.ok(result.packets > 0);
    assert.equal(result.diagnostics.audioState, 'running');
  } finally {
    await browser.close();
  }
});
