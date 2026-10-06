import json
import unittest
from types import SimpleNamespace

import evaluate


class MetricsTest(unittest.TestCase):
    def setUp(self):
        self.manifest = evaluate.load_manifest()
        self.fixtures = {item["id"]: item for item in self.manifest["fixtures"]}

    def test_cleanup_deletion_is_not_asr_error(self):
        fixture = self.fixtures["ami-1016"]
        final = {"raw": fixture["verbatim"], "text": fixture["target"]}
        result = evaluate.score(fixture, final, False, self.manifest["dictionary"]["words"])
        self.assertEqual(result["raw_verbatim"]["errors"], 0)
        self.assertGreater(result["raw_target"]["errors"], 0)
        self.assertEqual(result["clean_target"]["errors"], 0)

    def test_dictionary_hallucination_on_negative_is_false_positive(self):
        fixture = self.fixtures["negative-canon"]
        result = evaluate.score(fixture, {"raw": fixture["verbatim"], "text": "Send the file to Kenan."},
                                True, self.manifest["dictionary"]["words"])
        self.assertEqual(result["dictionary"]["clean"]["fp"], 1)
        self.assertFalse(result["expectation_pass"])

    def test_meaning_contract_does_not_allow_dictionary_name_insertion(self):
        fixture = self.fixtures["ami-4062"]
        final = {"raw": fixture["verbatim"], "text": fixture["target"] + " Kenan."}
        result = evaluate.score(fixture, final, True, self.manifest["dictionary"]["words"])
        self.assertTrue(result["meaning_proxy_pass"])
        self.assertFalse(result["expectation_pass"])

    def test_meaning_proxy_catches_negation_and_date_loss(self):
        for name, text in [("ami-11072", "A voice recognition function would make the remote control easier to use."),
                           ("ami-4062", "We're planning on having a big party on the twenty fifth.")]:
            self.assertTrue(evaluate.meaning_checks(self.fixtures[name], text)["missing"])

    def test_replacement_target_depends_on_dictionary_mode(self):
        fixture = self.fixtures["replacement-positive"]
        final = {"raw": fixture["verbatim"], "text": fixture["dictionary_target"]}
        self.assertTrue(evaluate.score(fixture, final, True, self.manifest["dictionary"]["words"])["expectation_pass"])
        self.assertFalse(evaluate.score(fixture, final, False, self.manifest["dictionary"]["words"])["lexical_exact"])

    def test_name_matching_is_token_bound_and_possessive_aware(self):
        self.assertEqual(evaluate.term_counts("Java's toolkit", ["Java"])["Java"], 1)
        self.assertEqual(evaluate.term_counts("Javanese", ["Java"])["Java"], 0)
        self.assertEqual(evaluate.term_counts("a real reactionary", ["Real Reaction"])["Real Reaction"], 0)

    def test_energy_trim_preserves_voice_and_guard(self):
        data = bytes(320) + b"\x00\x20" * 160 + bytes(3200)
        self.assertEqual(evaluate.tight_tail(data), data[:1280])


class ProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_engine_messages_and_replay_modes_are_rejected(self):
        from websockets.asyncio.server import serve
        manifest = evaluate.load_manifest()
        fixture = manifest["fixtures"][0]
        for message in ({"type": "future"}, None):
            async def handle(socket):
                async for frame in socket:
                    if isinstance(frame, str) and json.loads(frame)["type"] == "finish":
                        await socket.send(json.dumps(message))
                        await socket.send(json.dumps({"type": "final", "raw": fixture["verbatim"], "text": fixture["target"]}))
                        return
            async with serve(handle, "127.0.0.1", 0) as server:
                args = SimpleNamespace(url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}", chunk_ms=20, pace="burst", final_timeout=1)
                with self.assertRaises(ValueError):
                    await evaluate.replay_one(fixture, manifest, args, True, "immediate")
        for pace, finish in (("future", "immediate"), ("burst", "future")):
            with self.assertRaises(ValueError):
                await evaluate.replay_one(fixture, manifest, SimpleNamespace(pace=pace), True, finish)

    async def test_finish_follows_all_pcm_without_waiting_for_partials(self):
        from websockets.asyncio.server import serve
        manifest = evaluate.load_manifest()
        fixture = manifest["fixtures"][0]
        received = []

        async def handle(socket):
            received.append(json.loads(await socket.recv()))
            total = bytearray()
            async for frame in socket:
                if isinstance(frame, bytes):
                    total.extend(frame)
                else:
                    received.append(json.loads(frame))
                    received.append(bytes(total))
                    await socket.send(json.dumps({"type": "final", "raw": fixture["verbatim"], "text": fixture["target"]}))
                    return

        async with serve(handle, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            args = SimpleNamespace(url=f"ws://127.0.0.1:{port}", chunk_ms=20, pace="burst", final_timeout=1)
            for finish in ("immediate", "tight", "silence"):
                received.clear()
                row = await evaluate.replay_one(fixture, manifest, args, True, finish)
                self.assertEqual(received[0]["dictionary"], manifest["dictionary"])
                self.assertEqual(received[1], {"type": "finish"})
                expected = evaluate.pcm(fixture)
                if finish == "tight":
                    expected = evaluate.tight_tail(expected)
                if finish == "silence":
                    expected += bytes(12800)
                self.assertEqual(received[2], expected)
                self.assertTrue(row["metrics"]["expectation_pass"])
                self.assertEqual(row["partial_messages"], 0)

    async def test_missing_raw_final_fails_instead_of_scoring_clean_as_raw(self):
        from websockets.asyncio.server import serve
        manifest = evaluate.load_manifest()
        fixture = manifest["fixtures"][0]

        async def handle(socket):
            async for frame in socket:
                if isinstance(frame, str) and json.loads(frame)["type"] == "finish":
                    await socket.send(json.dumps({"type": "final", "text": "Only clean"}))
                    return

        async with serve(handle, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            args = SimpleNamespace(url=f"ws://127.0.0.1:{port}", chunk_ms=20, pace="burst", final_timeout=1)
            with self.assertRaisesRegex(ValueError, "distinct raw"):
                await evaluate.replay_one(fixture, manifest, args, False, "immediate")


if __name__ == "__main__":
    unittest.main()
