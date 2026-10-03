"""Finish must own every queued sample, including quiet speech after speculation."""
import asyncio
import copy
import json
from types import SimpleNamespace
import unittest

import numpy as np

from server import Engine


class Socket:
    def __init__(self):
        self.frames = asyncio.Queue()
        self.final = asyncio.Future()

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.frames.get()

    async def send(self, message):
        event = json.loads(message)
        if event['type'] in ('final', 'error'):
            self.final.set_result(event)

    def send_frame(self, frame):
        self.frames.put_nowait(frame)


class Stream:
    def __init__(self):
        self.audio = np.empty(0, np.float32)
        self.samples_decoded = 0
        self.timings = []
        self.padding = None
        self.speculative = False
        self.speculated = False

    def accept(self, samples):
        self.audio = np.concatenate((self.audio, samples))
        self.samples_decoded = len(self.audio)

    def result(self):
        return {'words': []}

    def fork(self):
        fork = copy.copy(self)
        fork.speculative = True
        fork.origin = self
        return fork

    def finish(self, silence_samples=3200):
        self.padding = silence_samples
        if self.speculative:
            self.origin.speculated = True
        # A low-energy, final word is still speech, not disposable silence.
        words = ([{'w': 'default', 'conf': 1, 'alts': []}]
                 if np.any(np.isclose(self.audio, 32 / 32768)) else [])
        return {'text': ' '.join(word['w'] for word in words), 'words': words}


class SlotGate(asyncio.Semaphore):
    def __init__(self):
        super().__init__(0)
        self.entries = 0
        self.decoding = asyncio.Event()
        self.finishing = asyncio.Event()

    async def __aenter__(self):
        self.entries += 1
        (self.decoding if self.entries == 1 else self.finishing).set()
        return await super().__aenter__()


def engine_for(stream, slots):
    engine = Engine.__new__(Engine)
    engine.recognizer = SimpleNamespace(create_stream=lambda dictionary: stream)
    engine.slots = slots
    engine.tagger = engine.punctuator = None
    return engine


class FinishTest(unittest.IsolatedAsyncioTestCase):
    async def test_finish_while_waiting_for_encoder_slot_keeps_pcm_on_both_paths(self):
        for shadow in (False, True):
            with self.subTest(cpu_shadow=shadow):
                gpu, cpu = Stream(), Stream()
                gpu_gate, cpu_gate = SlotGate(), SlotGate()
                engine = engine_for(gpu, gpu_gate)
                if shadow:
                    engine.cpu_recognizer = SimpleNamespace(create_stream=lambda dictionary: cpu)
                    engine.cpu_slots = cpu_gate
                socket = Socket()
                handler = asyncio.create_task(engine.handle(socket))
                try:
                    socket.send_frame('{"type":"start"}')
                    socket.send_frame(b'\x20\x00' * 320)
                    await asyncio.wait_for(gpu_gate.decoding.wait(), 1)
                    if shadow:
                        await asyncio.wait_for(cpu_gate.decoding.wait(), 1)
                    socket.send_frame('{"type":"finish"}')
                    gate = cpu_gate if shadow else gpu_gate
                    await asyncio.wait_for(gate.finishing.wait(), 1)
                    gate.release()
                    final = await asyncio.wait_for(socket.final, 1)
                    self.assertEqual(final['type'], 'final')
                    self.assertEqual(final['raw'], 'default')
                    self.assertIn('default', final['text'].lower())
                    winner = cpu if shadow else gpu
                    self.assertEqual(len(winner.audio), 320)
                    self.assertGreaterEqual(winner.padding, 3200)
                    await asyncio.wait_for(handler, 1)
                finally:
                    gpu_gate.release(); cpu_gate.release()
                    if not handler.done():
                        handler.cancel()
                    await asyncio.gather(handler, return_exceptions=True)

    async def test_quiet_tail_after_speculation_is_not_replaced_by_old_final(self):
        stream = Stream()
        speculative_ready = asyncio.Event()

        class Slots(asyncio.Semaphore):
            async def __aexit__(self, *args):
                await super().__aexit__(*args)
                if stream.speculated:
                    speculative_ready.set()

        engine = engine_for(stream, Slots(1))
        socket = Socket()
        handler = asyncio.create_task(engine.handle(socket))
        try:
            socket.send_frame('{"type":"start"}')
            socket.send_frame(b'\x00\x10' * 320)
            socket.send_frame(b'\x00\x00' * 1920)
            await asyncio.wait_for(speculative_ready.wait(), 1)
            socket.send_frame(b'\x20\x00' * 320)
            socket.send_frame('{"type":"finish"}')
            final = await asyncio.wait_for(socket.final, 1)
            self.assertEqual(final['type'], 'final')
            self.assertEqual(final['raw'], 'default')
            self.assertFalse(final['timing']['speculative'])
            self.assertEqual(len(stream.audio), 2560)
            await asyncio.wait_for(handler, 1)
        finally:
            if not handler.done():
                handler.cancel()
            await asyncio.gather(handler, return_exceptions=True)

    async def test_cancel_does_not_wait_for_busy_encoder(self):
        stream, gate = Stream(), SlotGate()
        socket = Socket()
        handler = asyncio.create_task(engine_for(stream, gate).handle(socket))
        socket.send_frame('{"type":"start"}')
        socket.send_frame(b'\x20\x00' * 320)
        await asyncio.wait_for(gate.decoding.wait(), 1)
        socket.send_frame('{"type":"cancel"}')
        await asyncio.wait_for(handler, .1)
        self.assertFalse(socket.final.done())
        self.assertIsNone(stream.padding)
        gate.release()


if __name__ == '__main__':
    unittest.main()
