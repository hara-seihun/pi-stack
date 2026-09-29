"""Resident English streaming dictation on a loopback WebSocket."""
import argparse
import asyncio
import json
import logging
import os
import time
from pathlib import Path

# 32 OpenBLAS threads spin after every small mel projection and steal cores
# from ONNX's small encoder pool, tripling the 160 ms step latency.
os.environ['OPENBLAS_NUM_THREADS'] = '1'
import numpy as np
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from cleanup import IncrementalCleaner
from cleanup.tagger import JointOnnxTagger
from nemotron import Nemotron
from opus import OpusDecoder

LOG = logging.getLogger(__name__)


class Engine:
    """One WebSocket per dictation. A reader task only decodes and buffers audio,
    so a slow step never backs frames up in the socket; one decoder task per
    dictation advances the recognizer over everything buffered at once. While the
    tail is silent, a fork of the stream is finished ahead of ✓; `finish` uses it
    when nothing voiced arrived since, and otherwise finishes the live stream
    immediately rather than waiting for an obsolete speculation."""

    PARTIAL_INTERVAL = 0.1
    SPECULATE_AFTER_SILENCE = 0.12
    IMMEDIATE_PADDING = 1600

    def __init__(self, model_dir: Path, threads=4, streams=4, cleanup_dir: Path | None = None):
        self.recognizer = Nemotron(model_dir, threads)
        self.tagger = JointOnnxTagger(cleanup_dir) if cleanup_dir is not None else None
        self.slots = asyncio.Semaphore(streams)

    async def handle(self, socket):
        connected_at = time.perf_counter()
        state = {'last_audio_at': None, 'samples': 0, 'format': 'pcm'}
        pending = []
        arrived = asyncio.Event()
        stream = cleaner = decoder_task = None
        committed = []
        cleaned = [0]          # words already handed to the incremental cleaner
        voiced_at = 0          # samples received when the last voiced frame ended
        peak_rms = 0.0
        speculative = None     # (samples covered, result) finished from a fork
        speculating_at = None
        closing = False
        live_step = None       # the thread currently advancing the live stream
        clean_step = None      # the thread currently updating the cleaner

        async def advance():
            """Feed buffered audio to the stream; returns when the buffer is empty."""
            nonlocal committed, live_step
            while pending:
                batch = np.concatenate(pending); pending.clear()
                async with self.slots:
                    live_step = asyncio.ensure_future(asyncio.to_thread(stream.accept, batch))
                    await asyncio.shield(live_step)
            result = stream.result()
            stable = result['words'][:-2]
            if [w['w'] for w in stable[:len(committed)]] != [w['w'] for w in committed]:
                raise RuntimeError('Nemotron changed an emitted token')
            new_words = stable[len(committed):]
            committed = stable
            return result, new_words

        async def decode():
            nonlocal speculative, speculating_at
            last_partial = 0.0
            sent = None
            while not closing:
                await arrived.wait(); arrived.clear()
                if closing:
                    return
                result, new_words = await advance()
                partial = None
                if new_words:
                    nonlocal clean_step
                    cleaned[0] += len(new_words)
                    clean_step = asyncio.ensure_future(asyncio.to_thread(cleaner.update, new_words))
                    partial = await asyncio.shield(clean_step)
                now = time.perf_counter()
                tail = ' '.join(w['w'] for w in result['words'][len(committed):])
                text = (partial or {}).get('text', sent[0] if sent else '')
                if (text, tail) != sent and now - last_partial >= self.PARTIAL_INTERVAL:
                    await socket.send(json.dumps({'type': 'partial', 'committed': text, 'tail': tail}))
                    sent, last_partial = (text, tail), now
                received = state['samples']
                silent = (received - voiced_at) / 16000
                if silent >= self.SPECULATE_AFTER_SILENCE and not pending and speculating_at != received \
                        and (speculative is None or speculative[0] != received):
                    speculating_at = received
                    candidate, cleaner_copy, offset = stream.fork(), cleaner.fork(), cleaned[0]
                    def ahead():
                        finished = candidate.finish()
                        return finished, cleaner_copy.finish(finished['words'][offset:])
                    async with self.slots:
                        finished, final = await asyncio.to_thread(ahead)
                    if voiced_at <= received:
                        speculative = (received, finished, final)

        try:
            async for frame in socket:
                if isinstance(frame, bytes):
                    if stream is None:
                        raise ValueError('start must precede audio')
                    state['last_audio_at'] = time.perf_counter()
                    if state['format'] == 'opus':
                        samples = opus_decoder.decode(frame)
                    else:
                        data = remainder[0] + frame
                        remainder[0] = data[len(data) & ~1:]
                        data = data[:len(data) & ~1]
                        if not data:
                            continue
                        samples = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768
                    rms = float(np.sqrt(np.mean(samples * samples)))
                    peak_rms = max(peak_rms, rms)
                    state['samples'] += len(samples)
                    if rms > min(0.004, 0.08 * peak_rms):
                        voiced_at = state['samples']
                        speculative = None
                    pending.append(samples)
                    arrived.set()
                    continue
                command = json.loads(frame)
                kind = command.get('type')
                if kind == 'start' and stream is None:
                    dictionary = command.get('dictionary') or {}
                    context = command.get('context') or ''
                    state['format'] = command.get('audio', 'pcm')
                    if not isinstance(dictionary.get('words', []), list) or not isinstance(context, str) or state['format'] not in ('pcm', 'opus'):
                        raise ValueError('invalid dictionary, context or audio format')
                    opus_decoder = OpusDecoder() if state['format'] == 'opus' else None
                    remainder = [b'']
                    stream = self.recognizer.create_stream(dictionary)
                    cleaner = IncrementalCleaner(dictionary, context, tagger=self.tagger)
                    decoder_task = asyncio.create_task(decode())
                elif kind == 'cancel' and stream is not None:
                    return
                elif kind == 'finish' and stream is not None:
                    began = time.perf_counter()
                    gap = state['last_audio_at']
                    received = state['samples']
                    behind = (received - stream.samples_decoded) / 16000
                    closing = True; arrived.set()
                    hit = speculative is not None and speculative[0] <= received and voiced_at <= speculative[0]
                    # Never wait for a speculation: cancel the decoder. A hit already
                    # holds the cleaned final; otherwise let at most the one live
                    # step already running complete, then take over the stream.
                    decoder_task.cancel()
                    if hit:
                        result, final = speculative[1], speculative[2]
                    else:
                        if live_step is not None and not live_step.done():
                            await live_step
                        await advance()
                        # No speculation covers the tail (✓ while still speaking):
                        # 100 ms of silence padding instead of 200 keeps this to
                        # two encoder steps (+0.7 WER points on the last words).
                        async with self.slots:
                            result = await asyncio.to_thread(stream.finish, self.IMMEDIATE_PADDING)
                        if clean_step is not None and not clean_step.done():
                            await clean_step
                        final = await asyncio.to_thread(cleaner.finish, result['words'][cleaned[0]:])
                    elapsed = (time.perf_counter() - began)*1000
                    await socket.send(json.dumps({'type': 'final', 'text': final['text'], 'raw': result['text'], 'edits': final['edits'], 'words': result['words'], 'timing': {'flushMs': round(elapsed, 2), 'speculative': hit}}))
                    steps = sorted(stream.timings) or [0.0]
                    LOG.info('write dictation audio=%s audioSeconds=%.3f connectionSeconds=%.3f lastAudioToFinishMs=%s behindSeconds=%.3f stepP50Ms=%.1f stepMaxMs=%.1f flushMs=%.2f speculative=%s',
                             state['format'], received/16000, (time.perf_counter()-connected_at),
                             'none' if gap is None else f'{(began-gap)*1000:.2f}', behind,
                             steps[len(steps)//2], steps[-1], elapsed, hit)
                    return
                else:
                    raise ValueError('invalid command sequence')
        except ConnectionClosed:
            pass
        except (ValueError, TypeError) as error:
            await socket.send(json.dumps({'type': 'error', 'message': str(error)}))
        except Exception:
            LOG.exception('dictation failed')
            await socket.send(json.dumps({'type': 'error', 'message': 'recognition failed'}))
        finally:
            closing = True
            if decoder_task is not None and not decoder_task.done():
                decoder_task.cancel()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8797)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--streams', type=int, default=4)
    parser.add_argument('--cleanup-model', type=Path,
                        default=Path(__file__).resolve().parent/'cleanup-model')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    engine = Engine(args.model, args.threads, args.streams, args.cleanup_model)
    async with serve(engine.handle, args.host, args.port, max_size=4*1024*1024):
        LOG.info('Write ASR listening at %s:%d', args.host, args.port)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
