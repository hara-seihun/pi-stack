import asyncio
import json
from types import SimpleNamespace
import unittest

from rewrite import Decision
from test_finishing import Stream, Socket, engine_for


class RewriteStreamTest(unittest.IsolatedAsyncioTestCase):
    async def test_final_rewrite_has_its_own_stage_receipt_and_keeps_raw_words(self):
        engine = engine_for(Stream(), asyncio.Semaphore(1))
        calls = []
        def rewrite(source, baseline, dictionary):
            calls.append((source, baseline, dictionary))
            return Decision('Default revised.', 'applied', None, 12.5)
        engine.rewriter = SimpleNamespace(rewrite=rewrite)
        socket = Socket()
        handler = asyncio.create_task(engine.handle(socket))
        socket.send_frame(json.dumps({'type': 'start', 'dictionary': {'words': ['Default']}}))
        socket.send_frame(b'\x20\x00' * 320)
        socket.send_frame('{"type":"finish"}')
        final = await asyncio.wait_for(socket.final, 1)
        await asyncio.wait_for(handler, 1)
        self.assertEqual(calls[0][0], 'Default')
        self.assertEqual(final['raw'], 'default')
        self.assertEqual(final['text'], 'Default revised.')
        self.assertEqual(final['rewrite'], {'status': 'applied', 'reason': None, 'latencyMs': 12.5})
        self.assertEqual(final['edits'][-1]['kind'], 'rewrite')
        self.assertEqual(final['edits'][-1]['at'], [0, 1])

    async def test_verbatim_transcription_does_not_run_the_editor(self):
        engine = engine_for(Stream(), asyncio.Semaphore(1))
        def unexpected(*args):
            self.fail('A raw meeting transcript must not enter the editor')
        engine.rewriter = SimpleNamespace(rewrite=unexpected)
        socket = Socket()
        handler = asyncio.create_task(engine.handle(socket))
        socket.send_frame('{"type":"start","rewrite":false}')
        socket.send_frame(b'\x20\x00' * 320)
        socket.send_frame('{"type":"finish"}')
        final = await asyncio.wait_for(socket.final, 1)
        await asyncio.wait_for(handler, 1)
        self.assertEqual(final['raw'], 'default')
        self.assertIsNone(final['rewrite'])

    async def test_unavailable_rewrite_keeps_clean_transcript_and_reports_degradation(self):
        engine = engine_for(Stream(), asyncio.Semaphore(1))
        engine.rewriter = SimpleNamespace(rewrite=lambda source, baseline, dictionary:
                                         Decision(baseline, 'unavailable', 'queue_busy', 8))
        socket = Socket()
        handler = asyncio.create_task(engine.handle(socket))
        socket.send_frame('{"type":"start"}')
        socket.send_frame(b'\x20\x00' * 320)
        socket.send_frame('{"type":"finish"}')
        final = await asyncio.wait_for(socket.final, 1)
        await asyncio.wait_for(handler, 1)
        self.assertEqual(final['text'], 'Default.')
        self.assertEqual(final['rewrite']['status'], 'unavailable')
        self.assertEqual(final['rewrite']['reason'], 'queue_busy')


if __name__ == '__main__':
    unittest.main()
