import unittest

from . import IncrementalCleaner, clean


class CleanupTest(unittest.TestCase):
    def test_spoken_repair_and_source_indices(self):
        words = [{'w': w, 'conf': None, 'alts': []}
                 for w in 'on Tuesday wait no Friday'.split()]
        result = clean(words)
        self.assertEqual(result['text'], 'On Friday.')
        self.assertIn({'kind': 'delete', 'from': 'Tuesday', 'to': '', 'at': [1, 2]},
                      result['edits'])

    def test_dictionary_and_alternatives(self):
        words = [{'w': 'pie', 'conf': .4, 'alts': [{'w': 'Pi', 'conf': .35}]},
                 {'w': 'stack', 'conf': None, 'alts': []}]
        result = clean(words, {'words': ['Pi'], 'replacements':
                              [{'from': 'Pi stack', 'to': 'Pi Stack'}]})
        self.assertEqual(result['text'], 'Pi Stack.')

    def test_dictionary_does_not_invent_support_for_unscored_alternatives(self):
        for alternatives in (['Pi'], [{'w': 'Pi'}], [{'w': 'Pi', 'conf': None}],
                             [{'w': 'Pi', 'conf': float('nan')}],
                             [{'w': 'Pi', 'conf': float('inf')}],
                             [{'w': 'Pi', 'conf': 2}], [{'w': 'Pi', 'conf': -.2}],
                             [{'w': 'Pi', 'conf': .1}]):
            with self.subTest(alternatives=alternatives):
                result = clean([{'w': 'pie', 'conf': .4, 'alts': alternatives}],
                               {'words': ['Pi']})
                self.assertEqual(result['text'], 'Pie.')
                self.assertFalse(any(edit['kind'] == 'substitute' for edit in result['edits']))

    def test_dictionary_does_not_override_confident_ordinary_word(self):
        result = clean([{'w': 'pie', 'conf': .9,
                         'alts': [{'w': 'Pi', 'conf': .85}]}], {'words': ['Pi']})
        self.assertEqual(result['text'], 'Pie.')

    def test_dictionary_selects_best_supported_candidate_not_list_order(self):
        result = clean([{'w': 'misheard', 'conf': .4, 'alts': [
            {'w': 'Kelana', 'conf': .3}, {'w': 'Kenan', 'conf': .39}]}],
            {'words': ['Kelana', 'Kenan']})
        self.assertEqual(result['text'], 'Kenan.')

    def test_explicit_replacement_authorizes_unscored_correction(self):
        result = clean([{'w': 'pie', 'conf': None, 'alts': ['Pi']}],
                       {'replacements': [{'from': 'pie', 'to': 'Pi'}]})
        self.assertEqual(result['text'], 'Pi.')

    def test_incremental_boundary_and_finish(self):
        source = 'we spoke yesterday. on Tuesday wait no Friday and then met there.'
        words = [{'w': w, 'conf': None, 'alts': []} for w in source.split()]
        session = IncrementalCleaner(lookbehind=2)
        for i in range(0, len(words), 2):
            session.update(words[i:i+2])
        self.assertEqual(session.finish(), clean(words))

    def test_tagger_keeps_original_edit_positions(self):
        class Tagger:
            def predict(self, words):
                return [(1, 1.0) if w == 'uh' else (0, 1.0) for w in words]
        result = clean('Send uh notes'.split(), tagger=Tagger())
        self.assertEqual(result['text'], 'Send notes.')
        self.assertIn({'kind':'delete','from':'uh','to':'','at':[1,2]}, result['edits'])
        session = IncrementalCleaner(tagger=Tagger())
        session.update(['Send'])
        self.assertEqual(session.finish(['uh', 'notes']), result)

    def test_tagger_threshold_and_content_guard(self):
        class Tagger:
            deletion_threshold = .925
            def predict(self, words):
                return [(1, .93) for _ in words]
        result = clean('not 25 Sybil uh'.split(), {'words':['Sybil']}, tagger=Tagger())
        self.assertEqual(result['text'], 'Not 25 Sybil.')
        self.assertEqual([e['at'] for e in result['edits'] if e['kind']=='delete'], [[3,4]])

    def test_literal_quoted_fillers_are_content_not_disfluencies(self):
        class Tagger:
            def predict(self, words):
                return [(1, 1.0) if w.strip('“”"') in {'uh', 'um'} else (0, 1.0)
                        for w in words]
        for quote in ('"uh um"', '“uh um”'):
            source = ('the exact string is ' + quote).split()
            result = clean(source, tagger=Tagger())
            self.assertIn(quote, result['text'])
            self.assertFalse(any(edit['kind'] == 'delete' for edit in result['edits']))
        self.assertEqual(clean(['uh', 'um'], context='The exact string is “',
                               tagger=Tagger())['text'], 'uh um.')

    def test_literal_quote_contents_are_not_repunctuated(self):
        class Punctuator:
            def punctuate(self, words):
                return [word + ',' for word in words]
        result = clean('the exact string is "uh um"'.split(), punctuator=Punctuator())
        self.assertIn('"uh um"', result['text'])
        self.assertFalse(any(edit['kind'] == 'format' and edit['at'][0] >= 4
                             for edit in result['edits']))

    def test_literal_quote_protection_ends_at_closing_mark(self):
        result = clean('the string is “uh um” uh send it'.split())
        self.assertIn('“uh um”', result['text'])
        self.assertEqual([edit['at'] for edit in result['edits'] if edit['kind'] == 'delete'], [[5, 6]])

    def test_commands_are_format_edits(self):
        words = 'tasks colon bullet point review code bullet point send notes'.split()
        self.assertEqual(clean(words)['text'], 'Tasks:\n- Review code\n- Send notes.')


if __name__ == '__main__':
    unittest.main()
