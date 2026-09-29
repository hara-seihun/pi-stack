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
    def __init__(self, model_dir: Path, threads=6, streams=4, cleanup_dir: Path | None = None):
        self.recognizer = Nemotron(model_dir, threads)
        self.tagger = JointOnnxTagger(cleanup_dir) if cleanup_dir is not None else None
        self.slots = asyncio.Semaphore(streams)

    async def handle(self, socket):
        connected_at = time.perf_counter()
        last_audio_at = None
        audio_samples = 0
        audio_format = 'pcm'
        opus_decoder = None
        stream = None
        dictionary = {}
        context = ''
        committed = []
        cleaner = None
        remainder = b''
        generation = 0
        peak_rms = 0.0
        speculative = None
        speculation_task = None
        stream_lock = asyncio.Lock()

        async def speculate():
            nonlocal speculative
            while True:
                version = generation
                async with stream_lock:
                    candidate = stream.fork()
                async with self.slots:
                    result = await asyncio.to_thread(candidate.finish)
                if version == generation:
                    speculative = result
                    return
        try:
            async for frame in socket:
                if isinstance(frame, bytes):
                    if stream is None:
                        raise ValueError('start must precede audio')
                    last_audio_at = time.perf_counter()
                    if opus_decoder is not None:
                        samples = opus_decoder.decode(frame)
                    else:
                        data = remainder + frame
                        remainder = data[len(data) & ~1:]
                        data = data[:len(data) & ~1]
                        if not data:
                            continue
                        samples = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768
                    audio_samples += len(samples)
                    rms = float(np.sqrt(np.mean(samples * samples)))
                    peak_rms = max(peak_rms, rms)
                    voiced = rms > min(0.004, 0.08 * peak_rms)
                    if voiced:
                        generation += 1
                        speculative = None
                    async with stream_lock, self.slots:
                        await asyncio.to_thread(stream.accept, samples)
                    result = stream.result()
                    observed = result['words']
                    stable = observed[:-2]
                    if [w['w'] for w in stable[:len(committed)]] != [w['w'] for w in committed]:
                        raise RuntimeError('Nemotron changed an emitted token')
                    new_words = stable[len(committed):]
                    committed = stable
                    partial = await asyncio.to_thread(cleaner.update, new_words)
                    tail = observed[len(committed):]
                    await socket.send(json.dumps({'type': 'partial', 'committed': partial['text'], 'tail': ' '.join(w['w'] for w in tail), 'words': committed, 'unstableWords': tail}))
                    if speculation_task is None or speculation_task.done():
                        speculation_task = asyncio.create_task(speculate())
                    continue
                command = json.loads(frame)
                kind = command.get('type')
                if kind == 'start' and stream is None:
                    dictionary = command.get('dictionary') or {}
                    context = command.get('context') or ''
                    audio_format = command.get('audio', 'pcm')
                    if not isinstance(dictionary.get('words', []), list) or not isinstance(context, str) or audio_format not in ('pcm', 'opus'):
                        raise ValueError('invalid dictionary, context or audio format')
                    if audio_format == 'opus':
                        opus_decoder = OpusDecoder()
                    stream = self.recognizer.create_stream(dictionary)
                    cleaner = IncrementalCleaner(dictionary, context, tagger=self.tagger)
                elif kind == 'cancel' and stream is not None:
                    return
                elif kind == 'finish' and stream is not None:
                    began = time.perf_counter()
                    last_audio_gap_ms = (began - last_audio_at)*1000 if last_audio_at is not None else None
                    if speculative is None and speculation_task is not None:
                        await speculation_task
                    hit = speculative is not None
                    if hit:
                        result = speculative
                    else:
                        async with self.slots:
                            result = await asyncio.to_thread(stream.finish)
                    cleaned = await asyncio.to_thread(cleaner.finish, result['words'][len(committed):])
                    elapsed = (time.perf_counter() - began)*1000
                    await socket.send(json.dumps({'type': 'final', 'text': cleaned['text'], 'raw': result['text'], 'edits': cleaned['edits'], 'words': result['words'], 'timing': {'flushMs': round(elapsed, 2), 'speculative': hit}}))
                    LOG.info('write dictation audio=%s audioSeconds=%.3f connectionSeconds=%.3f lastAudioToFinishMs=%s flushMs=%.2f speculative=%s',
                             audio_format, audio_samples/16000, (time.perf_counter()-connected_at),
                             'none' if last_audio_gap_ms is None else f'{last_audio_gap_ms:.2f}', elapsed, hit)
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


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8797)
    parser.add_argument('--threads', type=int, default=6)
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
