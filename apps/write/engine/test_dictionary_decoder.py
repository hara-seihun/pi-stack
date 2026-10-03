"""Context may change lexical paths, never already committed source words."""
from types import SimpleNamespace
import unittest

import numpy as np

from dictionary import PhraseBias
from dictionary_decoder import DictionaryDecoder
from nemotron import Nemotron, Stream


class PhraseBiasTest(unittest.TestCase):
    def setUp(self):
        self.vocab = {0: '▁Jo', 1: 'di', 2: 'e', 3: 'dy', 4: '▁K', 5: 'en',
                      6: 'an', 7: '▁p', 8: '▁po', 9: 'ok', 10: 'ke', 11: 'ry', 12: 'ery'}

    def test_spelling_not_canonical_bpe_segmentation(self):
        bias = PhraseBias(self.vocab, ['pokery'])
        self.assertEqual(set(bias.candidates(' po')), {10})
        self.assertEqual(set(bias.candidates(' poke')), {11})
        # Both the canonical p+ok+ery and acoustic po+ke+ry are accepted.
        self.assertEqual(set(bias.candidates(' pok')), {2, 12})

    def test_casefold_and_no_substring_prefix(self):
        bias = PhraseBias(self.vocab, ['Kenan'])
        self.assertEqual(bias.candidates(' ken'), (6,))
        self.assertFalse(bias.candidates(' token'))
        self.assertFalse(bias.candidates(' k'))

    def test_incomplete_bonus_is_refunded_on_divergence(self):
        bias = PhraseBias(self.vocab, ['Kenan'])
        self.assertEqual(bias.potential(' ken'), 2)
        self.assertEqual(bias.potential(' kenan'), 6)
        tail, bonus = bias.advance(' ken', 'on')
        self.assertEqual(bonus + bias.potential(tail), 0)
        tail, bonus = bias.advance(' kenan', 't')
        self.assertEqual(bonus + bias.potential(tail), 0)

    def test_completion_is_confirmed_once_at_word_boundary(self):
        bias = PhraseBias(self.vocab, ['Kenan'])
        tail, bonus = bias.advance(' kenan', '▁will')
        self.assertEqual(bonus, 6)
        self.assertEqual(bias.potential(tail), 0)
        tail, again = bias.advance(tail, '▁send')
        self.assertEqual(again, 0)
        self.assertLessEqual(len(tail), bias.max_length)

    def test_overlapping_names_do_not_multiply_reward(self):
        bias = PhraseBias(self.vocab, ['Jodie', 'Jo', 'Jodie', 'jodie'])
        self.assertEqual(bias.potential(' jodie'), 6)

    def test_explicit_replacement_source_is_recognition_context(self):
        model = SimpleNamespace(vocab=self.vocab)
        stream = Nemotron.create_stream(model, {'words': ['Jodie'], 'replacements': [
            {'from': 'pokery', 'to': 'CustomName'}, {'from': 'unused'}, None]})
        self.assertEqual(set(stream.phrases.phrases), {' jodie', ' pokery'})


class ScriptedJoiner:
    def __init__(self):
        self.calls = []

    def run(self, unused, inputs):
        frame = int(inputs['encoder_outputs'][0, 0, 0])
        last = int(inputs['targets'][0, 0])
        self.calls.append((frame, last))
        scores = np.full(10, -20., np.float32)
        wanted = [0, 1, 3, 4, 5, 6, 7, 8][min(frame, 7)]
        if last == wanted or (frame == 1 and last == 2):
            scores[9] = 0
        else:
            scores[wanted] = 0
            scores[9] = -5
            if frame == 1:
                scores[2] = -1.0
        return scores[None, None, None], None, inputs['input_states_1'].copy(), inputs['input_states_2'].copy()


class DictionaryDecoderTest(unittest.TestCase):
    def decoder(self):
        vocabulary = {0: '▁Jo', 1: 'dy', 2: 'die', 3: '▁do', 4: '▁not',
                      5: '▁send', 6: '▁twelve', 7: '▁files', 8: '▁today'}
        model = SimpleNamespace(vocab=vocabulary, decoder=ScriptedJoiner())
        return DictionaryDecoder(model, PhraseBias(vocabulary, ['Jodie']), 9)

    def words(self, decoder):
        stream = object.__new__(Stream)
        stream.dictionary_decoder = decoder
        stream._dictionary_visible()
        return stream.result()['words']

    def test_stream_common_prefix_is_monotonic_through_branch_resolution(self):
        decoder = self.decoder()
        committed = []
        saw_branch = False
        for frame in range(8):
            decoder.frame(np.array([[[frame]]], np.float32), frame * .08)
            saw_branch |= len(decoder.beam) > 1
            words = self.words(decoder)[:-2]
            self.assertEqual([w['w'] for w in words[:len(committed)]], committed)
            committed = [w['w'] for w in words]
        self.assertTrue(saw_branch)
        self.assertGreater(len(committed), 2)
        decoder.finished = True
        final = self.words(decoder)
        self.assertEqual([w['w'] for w in final[:len(committed)]], committed)
        self.assertEqual([w['w'] for w in final], ['Jodie', 'do', 'not', 'send', 'twelve', 'files', 'today'])

    def test_confidence_is_unbiased_joiner_support(self):
        decoder = self.decoder()
        for frame in range(3):
            decoder.frame(np.array([[[frame]]], np.float32), frame * .08)
        decoder.finished = True
        word = self.words(decoder)[0]
        self.assertEqual(word['w'], 'Jodie')
        # die has less local support than dy even though context selected it.
        self.assertLess(word['conf'], .6)
        self.assertTrue(any(alt['w'] == 'Jody' and alt['conf'] > word['conf'] for alt in word['alts']))

    def test_completed_name_cannot_delete_following_quote_control(self):
        decoder = self.decoder()
        for frame in range(2):
            decoder.frame(np.array([[[frame]]], np.float32), frame * .08)
        decoder.beam = [decoder.beam[0]]
        self.assertEqual(''.join(decoder.beam[0].pieces), '▁Jodie')
        decoder.model.vocab[3] = '▁close'
        decoder.frame(np.array([[[2]]], np.float32), .16)
        self.assertTrue(all(hypothesis.pieces[-1] == '▁close' for hypothesis in decoder.beam))

    def test_fork_does_not_finish_or_advance_original(self):
        decoder = self.decoder()
        decoder.frame(np.array([[[0]]], np.float32), 0)
        fork = decoder.fork()
        original = decoder.beam.copy()
        fork.frame(np.array([[[1]]], np.float32), .08)
        fork.finished = True
        self.assertFalse(decoder.finished)
        self.assertEqual([h.ids for h in decoder.beam], [h.ids for h in original])
        self.assertNotEqual(fork.beam[0].ids, decoder.beam[0].ids)


if __name__ == '__main__':
    unittest.main()
