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
    def __init__(self): self.audio = []
    def accept(self, samples): self.audio.extend(samples)
    def result(self): return {'words': []}
    def fork(self): return self
    def finish(self): return {'words': [], 'text': ''}


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
        engine.slots = asyncio.Semaphore(2)
        with self.assertLogs('server', level='INFO') as logs:
            async with serve(engine.handle, '127.0.0.1', 0) as listener:
                port = listener.sockets[0].getsockname()[1]
                async with connect(f'ws://127.0.0.1:{port}') as socket:
                    await socket.send(json.dumps({'type':'start','dictation':'probe','audio':'opus','dictionary':{'words':[],'replacements':[]}}))
                    packets = encoded_packets()
                    for packet in packets:
                        await socket.send(packet)
                        self.assertEqual(json.loads(await socket.recv())['type'], 'partial')
                    await socket.send('{"type":"finish"}')
                    self.assertEqual(json.loads(await socket.recv())['type'], 'final')
        self.assertEqual(len(audio.audio), len(packets)*320)
        self.assertIn(f'audioSeconds={len(packets)*.02:.3f}', logs.output[-1])
        self.assertIn('lastAudioToFinishMs=', logs.output[-1])
        self.assertIn('flushMs=', logs.output[-1])
        self.assertIn('speculative=', logs.output[-1])


if __name__ == '__main__':
    unittest.main()
