import asyncio
import io
import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from gpu_encoder import device_mode
from protocol import Phase, parse_control
from rewrite import Decision, LocalRewriter
from test_finishing import Socket, Stream, engine_for


class ProtocolTest(unittest.TestCase):
    def test_only_known_control_variants_and_start_defaults(self):
        self.assertEqual(parse_control('{"type":"start"}', Phase.AWAITING_START),
                         {'type': 'start', 'audio': 'pcm', 'rewrite': True, 'dictionary': {}, 'context': ''})
        for phase in Phase:
            for command in (None, [], True, 'start', {}, {'type': 'future'}, {'type': 4}):
                with self.subTest(phase=phase, command=command), self.assertRaises(ValueError):
                    parse_control(json.dumps(command), phase)
        for kind in ('finish', 'cancel'):
            with self.assertRaises(ValueError):
                parse_control(json.dumps({'type': kind}), Phase.AWAITING_START)
            self.assertEqual(parse_control(json.dumps({'type': kind}), Phase.STREAMING), {'type': kind})
        with self.assertRaises(ValueError):
            parse_control('{"type":"start"}', Phase.STREAMING)

    def test_invalid_start_values_are_not_empty_settings(self):
        for field, values in {'dictionary': [None, False, [], ''], 'context': [None, False, []],
                              'audio': [None, '', 'future'], 'rewrite': [None, '', 1]}.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    parse_control(json.dumps({'type': 'start', field: value}), Phase.AWAITING_START)
        with self.assertRaises(ValueError):
            parse_control('{"type":"start"}', 'future-phase')

    def test_unknown_device_and_rewrite_states_are_rejected(self):
        for mode in ('cpu', 'auto', 'gpu'):
            with patch.dict('os.environ', {'PI_STACK_WRITE_DEVICE': mode}):
                self.assertEqual(device_mode(), mode)
        with patch.dict('os.environ', {'PI_STACK_WRITE_DEVICE': 'future'}), self.assertRaises(ValueError):
            device_mode()
        with self.assertRaises(ValueError):
            Decision('text', 'future', None, 0)

    def test_unknown_provider_finish_reason_is_not_a_generation_limit(self):
        runtime = object.__new__(LocalRewriter)
        runtime.url, runtime.secret, runtime.timeout = 'http://127.0.0.1:1', 'test', 1
        for reason in ('stop', 'length', 'future', None):
            body = json.dumps({'choices': [{'message': {'content': 'Hello.'}, 'finish_reason': reason}]}).encode()
            runtime.opener = SimpleNamespace(open=lambda *args, **kwargs: io.BytesIO(body))
            if reason in ('stop', 'length'):
                self.assertEqual(runtime._request('hello', {}), ('Hello.', reason))
            else:
                with self.assertRaises(ValueError):
                    runtime._request('hello', {})


class SocketProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_frames_report_protocol_errors_without_starting_recognition(self):
        for frame, message in [('null', 'command must be an object'),
                               ('{"type":"start","dictionary":false}', 'invalid dictionary'),
                               ('{"type":"future"}', 'unknown command type'),
                               ('{"type":"finish"}', 'start must precede finish')]:
            with self.subTest(frame=frame):
                stream = Stream()
                socket = Socket()
                socket.send_frame(frame)
                await asyncio.wait_for(engine_for(stream, asyncio.Semaphore(1)).handle(socket), 1)
                self.assertEqual(await socket.final, {'type': 'error', 'message': message})
                self.assertEqual(stream.samples_decoded, 0)
