"""Immediate finalization must retain spoken terminal words."""
import os
from pathlib import Path
import unittest
import wave

import numpy as np
from nemotron import Nemotron


@unittest.skipUnless(os.getenv('PI_STACK_TEST_MEET_RECOGNITION_MODEL'), 'set PI_STACK_TEST_MEET_RECOGNITION_MODEL to pinned CPU weights')
class AudioTailTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = Nemotron(Path(os.environ['PI_STACK_TEST_MEET_RECOGNITION_MODEL']), threads=2)

    def test_terminal_date_and_tool_name_survive_immediate_finish(self):
        fixtures = Path(__file__).resolve().parent / 'fixtures'
        for name, terminal in [('ami-4062', 'twenty fourth'), ('ami-1040', 'toolkit')]:
            with self.subTest(fixture=name):
                with wave.open(str(fixtures / (name + '.wav')), 'rb') as audio:
                    self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()), (16000, 1, 2))
                    samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
                stream = self.model.create_stream()
                for offset in range(0, len(samples), 320):
                    stream.accept(samples[offset:offset + 320])
                self.assertTrue(stream.finish()['text'].lower().rstrip('.?!').endswith(terminal))


if __name__ == '__main__':
    unittest.main()
