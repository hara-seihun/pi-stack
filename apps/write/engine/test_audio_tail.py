"""Real-speech end-of-stream regression using licensed committed AMI fixtures."""
import os
from pathlib import Path
import unittest
import wave

import numpy as np
from nemotron import Nemotron
from server import Engine


@unittest.skipUnless(os.getenv('PI_STACK_TEST_WRITE_MODEL'), 'set PI_STACK_TEST_WRITE_MODEL to pinned Nemotron weights')
class AudioTailTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = Nemotron(Path(os.environ['PI_STACK_TEST_WRITE_MODEL']), threads=2, enable_gpu=False)

    def test_finish_preserves_terminal_date_and_tool_name(self):
        fixtures = Path(__file__).resolve().parent.parent / 'eval' / 'audio'
        for name, terminal in [('ami-4062', 'twenty fourth'), ('ami-1040', 'toolkit')]:
            with self.subTest(fixture=name):
                with wave.open(str(fixtures / (name + '.wav')), 'rb') as audio:
                    self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()), (16000, 1, 2))
                    samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
                stream = self.model.create_stream()
                for offset in range(0, len(samples), 320):
                    stream.accept(samples[offset:offset + 320])
                final = stream.finish(Engine.FINAL_PADDING)
                self.assertTrue(final['text'].lower().rstrip('.?!').endswith(terminal), final['text'])


if __name__ == '__main__':
    unittest.main()
