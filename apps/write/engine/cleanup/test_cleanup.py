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
        words = [{'w': 'pie', 'conf': .4, 'alts': ['Pi']},
                 {'w': 'stack', 'conf': None, 'alts': []}]
        result = clean(words, {'words': ['Pi'], 'replacements':
                              [{'from': 'Pi stack', 'to': 'Pi Stack'}]})
        self.assertEqual(result['text'], 'Pi Stack.')

    def test_incremental_boundary_and_finish(self):
        source = 'we spoke yesterday. on Tuesday wait no Friday and then met there.'
        words = [{'w': w, 'conf': None, 'alts': []} for w in source.split()]
        session = IncrementalCleaner(lookbehind=2)
        for i in range(0, len(words), 2):
            session.update(words[i:i+2])
        self.assertEqual(session.finish(), clean(words))

    def test_commands_are_format_edits(self):
        words = 'tasks colon bullet point review code bullet point send notes'.split()
        self.assertEqual(clean(words)['text'], 'Tasks:\n- Review code\n- Send notes.')


if __name__ == '__main__':
    unittest.main()
