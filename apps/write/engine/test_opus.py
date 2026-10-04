"""Raw Android-style 20 ms Opus packets decode without an Ogg/container header."""
import asyncio
import json
import unittest
from fractions import Fraction

import av
import numpy as np

from opus import OpusDecoder


def encoded_packets(count=5):
    encoder = av.CodecContext.create('libopus', 'w')
    encoder.sample_rate = 16000
    encoder.layout = 'mono'
    encoder.format = 's16'
    encoder.bit_rate = 24000
    encoder.time_base = Fraction(1, 16000)
    encoder.open()
    packets = []
    for index in range(count):
        times = (np.arange(320) + index*320)/16000
        pcm = (np.sin(2*np.pi*440*times)*12000).astype(np.int16)
        frame = av.AudioFrame.from_ndarray(pcm[None, :], format='s16', layout='mono')
        frame.sample_rate = 16000
        frame.pts = index*320
        packets.extend(bytes(packet) for packet in encoder.encode(frame))
    return packets


class OpusPacketTest(unittest.TestCase):
    def test_four_packets_decode_to_16k_mono_pcm_and_keep_duration(self):
        packets = encoded_packets()
        self.assertGreaterEqual(len(packets), 4)
        decoder = OpusDecoder()
        results = [decoder.decode(packet) for packet in packets]
        self.assertTrue(all(samples.dtype == np.float32 and samples.shape == (320,) for samples in results))
        self.assertGreater(np.max(np.abs(results[-1])), .1)
        self.assertEqual(sum(map(len, results)), 320*len(packets))

    def test_bad_packet_is_rejected(self):
        decoder = OpusDecoder()
        with self.assertRaises(ValueError): decoder.decode(b'')
        with self.assertRaises(ValueError): decoder.decode(b'\xff'*1600)


class FakeStream:
    def __init__(self, delay=0.0, finish_delay=0.0):
        self.audio = []; self.delay = delay; self.finish_delay = finish_delay
        self.samples_decoded = 0; self.timings = []; self.accepts = 0
    def accept(self, samples):
        import time; time.sleep(self.delay)
        self.audio.extend(samples); self.samples_decoded = len(self.audio); self.accepts += 1
    def result(self): return {'words': []}
    def fork(self): return self
    def finish(self, silence_samples=3200):
        import time; time.sleep(self.finish_delay)
        return {'words': [], 'text': ''}


class EngineProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_raw_packets_and_final_metrics(self):
        from types import SimpleNamespace
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect
        from server import Engine
        engine = Engine.__new__(Engine)
        audio = FakeStream()
        engine.recognizer = SimpleNamespace(create_stream=lambda dictionary: audio)
        engine.tagger = None
        engine.punctuator = None
        engine.slots = asyncio.Semaphore(2)
        with self.assertLogs('server', level='INFO') as logs:
            async with serve(engine.handle, '127.0.0.1', 0) as listener:
                port = listener.sockets[0].getsockname()[1]
                async with connect(f'ws://127.0.0.1:{port}') as socket:
                    await socket.send(json.dumps({'type':'start','dictation':'probe','audio':'opus','dictionary':{'words':[],'replacements':[]}}))
                    packets = encoded_packets()
                    for packet in packets:
                        await socket.send(packet)
                    await socket.send('{"type":"finish"}')
                    while (reply := json.loads(await socket.recv()))['type'] == 'partial':
                        pass
                    self.assertEqual(reply['type'], 'final')
        self.assertEqual(len(audio.audio), len(packets)*320)
        self.assertIn(f'audioSeconds={len(packets)*.02:.3f}', logs.output[-1])
        self.assertIn('lastAudioToFinishMs=', logs.output[-1])
        self.assertIn('flushMs=', logs.output[-1])
        self.assertIn('speculative=', logs.output[-1])


if __name__ == '__main__':
    unittest.main()


class DualBackendTest(unittest.IsolatedAsyncioTestCase):
    def test_cpu_shadow_only_when_gpu_busy(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import time
        from server import Engine
        gpu = SimpleNamespace(busy_until=0)
        with patch('pathlib.Path.read_text', return_value='0'):
            self.assertFalse(Engine.cpu_shadow_needed(gpu))
        with patch('pathlib.Path.read_text', return_value='94'):
            self.assertTrue(Engine.cpu_shadow_needed(gpu))
        gpu.busy_until = time.monotonic()+1
        with patch('pathlib.Path.read_text', return_value='0'):
            self.assertTrue(Engine.cpu_shadow_needed(gpu))

    async def test_retry_promotes_future_dictations_without_mutating_cpu_streams(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from server import Engine
        engine = Engine.__new__(Engine)
        engine.model_dir = 'unused'
        engine.GPU_RETRY_SECONDS = .001
        original = SimpleNamespace(gpu=None)
        engine.recognizer = original
        engine.cpu_recognizer = None
        new_gpu = object()
        with patch.dict('os.environ', {'PI_STACK_WRITE_DEVICE':'auto'}), patch('server.maybe_load', return_value=new_gpu), patch('server.Nemotron', return_value=SimpleNamespace(gpu=None)):
            await engine.promote_when_available()
        self.assertIsNone(original.gpu)
        self.assertIs(engine.recognizer.gpu, new_gpu)
        self.assertIsNot(engine.recognizer, original)
        self.assertIsNotNone(engine.cpu_recognizer)

    async def test_cpu_shadow_wins_while_gpu_step_is_busy(self):
        from types import SimpleNamespace
        import time
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect
        from server import Engine
        engine = Engine.__new__(Engine)
        gpu = FakeStream(delay=.15, finish_delay=.15)
        cpu = FakeStream()
        engine.recognizer = SimpleNamespace(create_stream=lambda dictionary: gpu)
        engine.cpu_recognizer = SimpleNamespace(create_stream=lambda dictionary: cpu)
        engine.tagger = None
        engine.punctuator = None
        engine.slots = asyncio.Semaphore(2)
        engine.cpu_slots = asyncio.Semaphore(2)
        async with serve(engine.handle, '127.0.0.1', 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            async with connect(f'ws://127.0.0.1:{port}') as socket:
                await socket.send('{"type":"start", "dictionary":{"words":[]}}')
                await socket.send(b'\x10\x00'*320)
                began = time.perf_counter()
                await socket.send('{"type":"finish"}')
                while (reply := json.loads(await socket.recv()))['type'] == 'partial':
                    pass
                self.assertEqual(reply['type'], 'final')
                self.assertEqual(reply['timing']['encoder'], 'cpu')
                self.assertLess(time.perf_counter()-began, .1)
        self.assertEqual(len(cpu.audio), 320)


class SlowStepTest(unittest.IsolatedAsyncioTestCase):
    async def test_audio_arriving_during_a_slow_step_is_batched(self):
        """A step slower than real time must not make finish wait for one step per frame."""
        from types import SimpleNamespace
        import time
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect
        from server import Engine
        engine = Engine.__new__(Engine)
        audio = FakeStream(delay=0.1)
        engine.recognizer = SimpleNamespace(create_stream=lambda dictionary: audio)
        engine.tagger = None
        engine.punctuator = None
        engine.slots = asyncio.Semaphore(2)
        async with serve(engine.handle, '127.0.0.1', 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            async with connect(f'ws://127.0.0.1:{port}') as socket:
                await socket.send(json.dumps({'type': 'start', 'dictation': 'slow', 'dictionary': {'words': [], 'replacements': []}}))
                for _ in range(50):  # one second of PCM in 20 ms frames, sent at once
                    await socket.send(b'\x10\x00'*320)
                began = time.perf_counter()
                await socket.send('{"type":"finish"}')
                while (reply := json.loads(await socket.recv()))['type'] == 'partial':
                    pass
                self.assertEqual(reply['type'], 'final')
                self.assertLess(time.perf_counter() - began, 0.5)
        self.assertEqual(len(audio.audio), 50*320)
        self.assertLess(audio.accepts, 10)
