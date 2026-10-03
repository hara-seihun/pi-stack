import os
import re
import unittest
from pathlib import Path

from . import IncrementalCleaner, clean


class PunctuationPipelineTest(unittest.TestCase):
    def test_model_sees_cleaned_words_and_forks_keep_it(self):
        class Punctuator:
            def punctuate(self, tokens):
                self.seen = list(tokens)
                return [token + ('?' if i == len(tokens) - 1 else '')
                        for i, token in enumerate(tokens)]
        model = Punctuator()
        session = IncrementalCleaner(punctuator=model)
        session.update(['um', 'can', 'you'])
        fork = session.fork()
        result = fork.finish(['help'])
        self.assertEqual(model.seen, ['can', 'you', 'help'])
        self.assertEqual(result['text'], 'Can you help?')
        self.assertIn({'kind': 'format', 'from': 'help', 'to': 'help?', 'at': [3, 4]}, result['edits'])
        self.assertEqual(session.finish(['stay']), clean(['um', 'can', 'you', 'stay'], punctuator=model))


@unittest.skipUnless(os.getenv('PI_STACK_TEST_PUNCTUATION_MODEL'), 'pinned model not supplied')
class PinnedPunctuationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from .punctuation import OnnxPunctuator
        cls.model = OnnxPunctuator(Path(os.environ['PI_STACK_TEST_PUNCTUATION_MODEL']))

    def test_multi_sentence_dictation_and_question(self):
        text = 'whatever voice model we are using for Pi Stack right now does not do punctuation accurately or at all can you fix that'
        self.assertEqual(clean(text.split(), punctuator=self.model)['text'],
                         'Whatever voice model we are using for Pi Stack right now does not do punctuation accurately or at all. Can you fix that?')

    def test_explicit_commands_unicode_and_list_boundaries(self):
        for source, expected in [
            ('send it comma please period what next question mark', 'Send it, please. What next?'),
            ('why is café broken', 'Why is café broken?'),
            ('tasks colon bullet point review code bullet point send notes', 'Tasks:\n- Review code\n- Send notes.')]:
            self.assertEqual(clean(source.split(), punctuator=self.model)['text'], expected)

    def test_identifiers_and_long_overlapping_windows_preserve_content(self):
        words = ('do not change /home/kenan/hara user_name a@b.com 3.14 U.S.A. PiStack ' * 40).split()
        output = self.model.punctuate(words)
        self.assertEqual(len(output), len(words))
        for source, result in zip(words, output):
            self.assertEqual(re.sub(r'[.,?]', '', source), re.sub(r'[.,?]', '', result))
            if any(c in source for c in '/_@'):
                self.assertEqual(result, source)

    def test_chunked_cleanup_matches_final_and_keeps_edit_offsets(self):
        words = 'um can you send me the report I need it by Friday thanks'.split()
        session = IncrementalCleaner(punctuator=self.model)
        for start in range(0, len(words), 3):
            session.update(words[start:start + 3])
        self.assertEqual(session.finish(), clean(words, punctuator=self.model))


if __name__ == '__main__':
    unittest.main()
