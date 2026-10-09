import json
import unittest
from server import Engine


class Socket:
    def __init__(self, frames):
        self.frames = iter(frames)
        self.replies = []
    def __aiter__(self):
        return self
    async def __anext__(self):
        try:
            return next(self.frames)
        except StopIteration:
            raise StopAsyncIteration
    async def send(self, frame):
        self.replies.append(json.loads(frame))


class Recognizer:
    def __init__(self):
        self.audio = []
        self.padding = None
    def create_stream(self):
        return self
    def accept(self, samples):
        self.audio.extend(samples)
    def result(self):
        return {'text': ''}
    def finish(self, padding):
        self.padding = padding
        return {'text': 'raw self repair, no cleanup'}


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_silent_chunks_acknowledge_and_finish_flushes_the_tail(self):
        recognizer = Recognizer()
        engine = Engine(recognizer, 1)
        socket = Socket(['{"type":"start","turn":"1"}', b'\0\0', b'\0\0', '{"type":"finish"}'])
        await engine.handle(socket)
        self.assertEqual([reply['type'] for reply in socket.replies], ['partial', 'partial', 'final'])
        self.assertEqual(socket.replies[-1], {'type': 'final', 'text': 'raw self repair, no cleanup'})
        self.assertEqual(len(recognizer.audio), 2)
        self.assertEqual(recognizer.padding, 9600)
        self.assertEqual(engine.slots._value, 1)

    async def test_cancellation_and_invalid_pcm_release_capacity(self):
        for tail in [['{"type":"cancel"}'], [b'\1'], ['{"type":"finish"}']]:
            engine = Engine(Recognizer(), 1)
            socket = Socket(['{"type":"start","turn":"1"}', *tail])
            await engine.handle(socket)
            self.assertEqual(engine.slots._value, 1)
            self.assertFalse(any(reply['type'] == 'final' for reply in socket.replies))


if __name__ == '__main__':
    unittest.main()
