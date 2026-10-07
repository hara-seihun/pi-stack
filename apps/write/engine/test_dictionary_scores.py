"""Joiner alternatives carry their own support, never the primary's score."""
import math
import unittest

from nemotron import Stream
from cleanup import clean


class DictionaryScoresTest(unittest.TestCase):
    def stream(self, pieces, scores, alternatives, alternative_scores):
        stream = object.__new__(Stream)
        stream.pieces = pieces
        stream.token_scores = scores
        stream.alternative_pieces = alternatives
        stream.alternative_scores = alternative_scores
        stream.token_times = [i * .08 for i in range(len(pieces))]
        return stream

    def test_single_piece_alternative_has_actual_support(self):
        stream = self.stream(['▁pie'], [.4], [['▁Pi', '▁by']], [[.35, .1]])
        word = stream.result()['words'][0]
        self.assertEqual(word['conf'], .4)
        self.assertEqual(word['alts'], [{'w': 'Pi', 'conf': .35}, {'w': 'by', 'conf': .1}])
        self.assertEqual(clean([word], {'words': ['Pi']})['text'], 'Pi.')
        self.assertEqual(clean([word], {'words': ['by']})['text'], 'Pie.')

    def test_multi_piece_support_replaces_only_the_changed_piece(self):
        stream = self.stream(['▁Ke', 'nan'], [.5, .8], [['▁Ca'], ['na']], [[.1], [.7]])
        word = stream.result()['words'][0]
        self.assertEqual(word['w'], 'Kenan')
        self.assertAlmostEqual(word['conf'], math.sqrt(.5 * .8), places=4)
        self.assertEqual(word['alts'], [{'w': 'Kena', 'conf': .5916}, {'w': 'Canan', 'conf': .2828}])
        self.assertEqual(clean([word], {'words': ['Canan']})['text'], 'Kenan.')

    def test_alternatives_rank_globally_and_stay_within_word(self):
        stream = self.stream(['▁ab', 'c'], [.4, .5],
                             [['▁a', '▁x', '▁x y'], ['bc', 'd']],
                             [[.1, .2, .3], [.4, .1]])
        word = stream.result()['words'][0]
        self.assertEqual(word['alts'], [{'w': 'abbc', 'conf': .4},
                                       {'w': 'xc', 'conf': .3162},
                                       {'w': 'ac', 'conf': .2236}])
        self.assertTrue(all(' ' not in alt['w'] for alt in word['alts']))

    def test_word_boundary_keeps_scores_independent(self):
        stream = self.stream(['▁pie', '▁stack'], [.4, .9], [['▁Pi'], ['▁stuck']], [[.35], [.02]])
        words = stream.result()['words']
        self.assertEqual(words[0]['alts'], [{'w': 'Pi', 'conf': .35}])
        self.assertEqual(words[1]['alts'], [{'w': 'stuck', 'conf': .02}])
        self.assertEqual(clean(words, {'words': ['Pi', 'stuck']})['text'], 'Pi stack.')


if __name__ == '__main__':
    unittest.main()
