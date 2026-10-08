import unittest
from protocol import Phase, parse_control


class ProtocolTest(unittest.TestCase):
    def test_turn_lifetime_is_closed_and_raw(self):
        start = '{"type":"start","turn":"meeting-turn"}'
        self.assertEqual(parse_control(start, Phase.AWAITING_START), {'value': {'type': 'start', 'turn': 'meeting-turn'}})
        self.assertIn('error', parse_control(start, Phase.STREAMING))
        self.assertIn('error', parse_control('{"type":"finish"}', Phase.AWAITING_START))
        self.assertEqual(parse_control('{"type":"finish"}', Phase.STREAMING), {'value': {'type': 'finish'}})
        for frame in ['null', '[]', '{}', 'bad-json', '{"type":"start","turn":""}',
                      '{"type":"start","turn":"1","dictionary":{}}', '{"type":"rewrite"}']:
            self.assertIn('error', parse_control(frame, Phase.AWAITING_START))
        for phase in Phase:
            self.assertEqual(parse_control('{"type":"cancel"}', phase), {'value': {'type': 'cancel'}})


if __name__ == '__main__':
    unittest.main()
