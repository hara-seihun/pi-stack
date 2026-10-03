"""Resident English streaming dictation on a loopback WebSocket."""
import argparse
import asyncio
import copy
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
from cleanup.punctuation import OnnxPunctuator
from nemotron import Nemotron
from gpu_encoder import maybe_load
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
    GPU_RETRY_SECONDS = 20

    def __init__(self, model_dir: Path, threads=4, streams=4, cleanup_dir: Path | None = None,
                 punctuation_dir: Path | None = None):
        self.model_dir = model_dir
        self.recognizer = Nemotron(model_dir, threads)
        # A separate two-thread ORT pool keeps the CPU shadow warm without
        # oversubscribing the four-thread GPU service's dormant CPU encoder.
        self.cpu_recognizer = Nemotron(model_dir, threads=2, enable_gpu=False) if self.recognizer.gpu else None
        self.cpu_slots = asyncio.Semaphore(2)
        self.tagger = JointOnnxTagger(cleanup_dir) if cleanup_dir is not None else None
        self.punctuator = OnnxPunctuator(punctuation_dir) if punctuation_dir is not None else None
        self.slots = asyncio.Semaphore(streams)

    async def promote_when_available(self):
        """Transient GPU admission denial must not pin the daemon to CPU forever.

        Replace the model *object*, not its gpu field: existing CPU dictations
        retain their independent cache representation until their sockets close.
        """
        if os.getenv('PI_STACK_WRITE_DEVICE', 'cpu') not in ('auto', 'gpu'):
            return
        while self.recognizer.gpu is None:
            await asyncio.sleep(self.GPU_RETRY_SECONDS)
            gpu = await asyncio.to_thread(maybe_load, Path(__file__).resolve().parent/'gpu-model')
            if gpu is None:
                continue
            try:
                shadow = await asyncio.to_thread(Nemotron, self.model_dir, 2, False)
            except Exception:
                LOG.exception('Write CPU shadow pool failed to load; sharing the existing CPU pool')
                shadow = self.recognizer
            updated = copy.copy(self.recognizer)
            updated.gpu = gpu
            self.cpu_recognizer, self.recognizer = shadow, updated
            LOG.info('Write GPU admitted after CPU fallback; future dictations use dual encoder')

    @staticmethod
    def cpu_shadow_needed(gpu):
        if gpu is None:
            return False
        try:
            busy = int(Path('/sys/class/drm/card0/device/gpu_busy_percent').read_text())
        except (OSError, ValueError):
            busy = 0
        return busy >= 75 or time.monotonic() < gpu.busy_until

    async def handle(self, socket):
        connected_at = time.perf_counter()
        state = {'last_audio_at': None, 'samples': 0, 'format': 'pcm'}
        pending = []
        arrived = asyncio.Event()
        cpu_pending = []
        cpu_arrived = asyncio.Event()
        stream = cleaner = decoder_task = None
        cpu_stream = cpu_cleaner = cpu_task = None
        cpu_live_step = cpu_clean_step = None
        cpu_committed = []
        cpu_cleaned = [0]
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

        async def cpu_advance():
            nonlocal cpu_live_step, cpu_clean_step, cpu_committed
            while cpu_pending:
                batch = np.concatenate(cpu_pending); cpu_pending.clear()
                async with self.cpu_slots:
                    cpu_live_step = asyncio.ensure_future(asyncio.to_thread(cpu_stream.accept, batch))
                    await asyncio.shield(cpu_live_step)
            result = cpu_stream.result()
            stable = result['words'][:-2]
            if [w['w'] for w in stable[:len(cpu_committed)]] != [w['w'] for w in cpu_committed]:
                raise RuntimeError('CPU Nemotron changed an emitted token')
            new_words = stable[len(cpu_committed):]
            cpu_committed = stable
            if new_words:
                cpu_cleaned[0] += len(new_words)
                cpu_clean_step = asyncio.ensure_future(asyncio.to_thread(cpu_cleaner.update, new_words))
                await asyncio.shield(cpu_clean_step)

        async def cpu_decode():
            while not closing:
                await cpu_arrived.wait(); cpu_arrived.clear()
                if closing:
                    return
                await cpu_advance()

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
                    if cpu_stream is not None:
                        cpu_pending.append(samples)
                        cpu_arrived.set()
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
                    cleaner = IncrementalCleaner(dictionary, context, tagger=self.tagger,
                                                 punctuator=self.punctuator)
                    decoder_task = asyncio.create_task(decode())
                    gpu = getattr(getattr(stream, 'model', None), 'gpu', None)
                    if getattr(self, 'cpu_recognizer', None) is not None and (gpu is None or self.cpu_shadow_needed(gpu)):
                        cpu_stream = self.cpu_recognizer.create_stream(dictionary)
                        cpu_cleaner = IncrementalCleaner(dictionary, context, tagger=self.tagger,
                                                         punctuator=self.punctuator)
                        cpu_task = asyncio.create_task(cpu_decode())
                elif kind == 'cancel' and stream is not None:
                    return
                elif kind == 'finish' and stream is not None:
                    began = time.perf_counter()
                    gap = state['last_audio_at']
                    received = state['samples']
                    behind = (received - stream.samples_decoded) / 16000
                    cpu_behind = (received - cpu_stream.samples_decoded) / 16000 if cpu_stream is not None else 0
                    closing = True; arrived.set()
                    hit = speculative is not None and speculative[0] <= received and voiced_at <= speculative[0]
                    # Never wait for a speculation: cancel the decoder. A hit already
                    # holds the cleaned final; otherwise let at most the one live
                    # step already running complete, then take over the stream.
                    decoder_task.cancel()
                    if cpu_task is not None:
                        cpu_task.cancel(); cpu_arrived.set()
                    waited_at = advanced_at = tail_at = cleaned_at = began
                    winner = 'speculative' if hit else ('gpu' if getattr(getattr(stream, 'model', None), 'gpu', None) else 'cpu')
                    cpu_phases = [began, began, began, began, began]

                    async def gpu_finish():
                        nonlocal waited_at, advanced_at, tail_at, cleaned_at
                        if live_step is not None and not live_step.done():
                            await live_step
                        waited_at = time.perf_counter()
                        await advance()
                        advanced_at = time.perf_counter()
                        # Keep 100 ms of additional silence to resolve terminal
                        # wordpieces (removing it lost "default" as "def").
                        async with self.slots:
                            recognized = await asyncio.to_thread(stream.finish, self.IMMEDIATE_PADDING)
                        tail_at = time.perf_counter()
                        if clean_step is not None and not clean_step.done():
                            await clean_step
                        cleaned_result = await asyncio.to_thread(cleaner.finish, recognized['words'][cleaned[0]:])
                        cleaned_at = time.perf_counter()
                        return recognized, cleaned_result

                    async def cpu_finish():
                        if cpu_live_step is not None and not cpu_live_step.done():
                            await cpu_live_step
                        if cpu_clean_step is not None and not cpu_clean_step.done():
                            await cpu_clean_step
                        cpu_phases[1] = time.perf_counter()
                        await cpu_advance()
                        cpu_phases[2] = time.perf_counter()
                        async with self.cpu_slots:
                            recognized = await asyncio.to_thread(cpu_stream.finish, self.IMMEDIATE_PADDING)
                        cpu_phases[3] = time.perf_counter()
                        if cpu_clean_step is not None and not cpu_clean_step.done():
                            await cpu_clean_step
                        cleaned_result = await asyncio.to_thread(cpu_cleaner.finish, recognized['words'][cpu_cleaned[0]:])
                        cpu_phases[4] = time.perf_counter()
                        return recognized, cleaned_result

                    if hit:
                        result, final = speculative[1], speculative[2]
                    else:
                        tasks = {asyncio.create_task(gpu_finish()): 'gpu'}
                        if cpu_stream is not None:
                            tasks[asyncio.create_task(cpu_finish())] = 'cpu'
                        while tasks:
                            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                            chosen = False
                            for task in done:
                                source = tasks.pop(task)
                                try:
                                    result, final = task.result()
                                except Exception:
                                    LOG.exception('Write %s finalization failed; trying other encoder', source)
                                    continue
                                winner, chosen = source, True
                                break
                            if chosen:
                                for task in tasks:
                                    task.cancel()
                                break
                        else:
                            raise RuntimeError('Both Write encoders failed to finish')
                    if winner == 'cpu':
                        waited_at = advanced_at = tail_at = cleaned_at = began
                    else:
                        # A losing CPU task may have been canceled halfway
                        # through a phase; do not report negative durations.
                        cpu_phases = [began]*5
                    elapsed = (time.perf_counter() - began)*1000
                    await socket.send(json.dumps({'type': 'final', 'text': final['text'], 'raw': result['text'], 'edits': final['edits'], 'words': result['words'], 'timing': {'flushMs': round(elapsed, 2), 'speculative': hit, 'encoder': winner}}))
                    steps = sorted(stream.timings) or [0.0]
                    stages = getattr(stream, 'stage_timings', ())
                    gpu_wait = max((s['gpuWaitMs'] for s in stages), default=0)
                    gpu_encode = max((s['gpuEncodeMs'] for s in stages), default=0)
                    joint = max((s['jointMs'] for s in stages), default=0)
                    LOG.info('write dictation audio=%s audioSeconds=%.3f connectionSeconds=%.3f lastAudioToFinishMs=%s behindSeconds=%.3f stepP50Ms=%.1f stepMaxMs=%.1f flushMs=%.2f speculative=%s finishWaitMs=%.1f finishAdvanceMs=%.1f finishTailMs=%.1f finishCleanMs=%.1f gpuWaitMaxMs=%.1f gpuEncodeMaxMs=%.1f jointMaxMs=%.1f encoder=%s cpuBehindSeconds=%.3f cpuStepP50Ms=%.1f cpuStepMaxMs=%.1f cpuWaitMs=%.1f cpuAdvanceMs=%.1f cpuTailMs=%.1f cpuCleanMs=%.1f',
                             state['format'], received/16000, (time.perf_counter()-connected_at),
                             'none' if gap is None else f'{(began-gap)*1000:.2f}', behind,
                             steps[len(steps)//2], steps[-1], elapsed, hit,
                             (waited_at-began)*1000, (advanced_at-waited_at)*1000,
                             (tail_at-advanced_at)*1000, (cleaned_at-tail_at)*1000,
                             gpu_wait, gpu_encode, joint, winner, cpu_behind,
                             sorted(cpu_stream.timings)[len(cpu_stream.timings)//2] if cpu_stream and cpu_stream.timings else 0,
                             max(cpu_stream.timings) if cpu_stream and cpu_stream.timings else 0,
                             (cpu_phases[1]-cpu_phases[0])*1000,
                             (cpu_phases[2]-cpu_phases[1])*1000,
                             (cpu_phases[3]-cpu_phases[2])*1000,
                             (cpu_phases[4]-cpu_phases[3])*1000)
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
            if cpu_task is not None and not cpu_task.done():
                cpu_task.cancel()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8797)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--streams', type=int, default=4)
    parser.add_argument('--cleanup-model', type=Path,
                        default=Path(__file__).resolve().parent/'cleanup-model')
    parser.add_argument('--punctuation-model', type=Path,
                        default=Path(__file__).resolve().parent/'punctuation-model')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    engine = Engine(args.model, args.threads, args.streams, args.cleanup_model,
                    args.punctuation_model)
    asyncio.create_task(engine.promote_when_available())
    async with serve(engine.handle, args.host, args.port, max_size=4*1024*1024):
        LOG.info('Write ASR listening at %s:%d', args.host, args.port)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
