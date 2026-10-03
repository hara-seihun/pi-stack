import os
import re
import unittest
from pathlib import Path

from . import IncrementalCleaner, clean


def quoted_text(text):
    return re.findall('“([^”]*)”', text)


class QuotationTest(unittest.TestCase):
    def test_spoken_controls_and_spacing(self):
        for source, expected in [
            ('quote hello unquote', '“Hello.”'),
            ('open quote hello close quote', '“Hello.”'),
            ('she said quote hello unquote today', 'She said “Hello” today.'),
            ('she said open quote hello close quote today', 'She said “Hello” today.'),
            ('quote hello unquote and quote goodbye unquote', '“Hello” and “goodbye.”'),
        ]:
            with self.subTest(source=source):
                self.assertEqual(clean(source.split())['text'], expected)

    def test_ordinary_quote_word_is_not_a_command(self):
        for source in ['quote me a price', 'please quote me a price']:
            with self.subTest(source=source):
                result = clean(source.split())
                self.assertEqual(result['text'], source[0].upper() + source[1:] + '.')
                self.assertEqual(quoted_text(result['text']), [])

    def test_quotation_controls_keep_source_offsets(self):
        result = clean('um open quote hello close quote'.split())
        self.assertEqual(result['text'], '“Hello.”')
        self.assertIn({'kind': 'format', 'from': 'open quote', 'to': '“', 'at': [1, 3]},
                      result['edits'])
        self.assertIn({'kind': 'format', 'from': 'close quote', 'to': '”', 'at': [4, 6]},
                      result['edits'])

    def test_fillers_and_repairs_inside_quote_are_literal(self):
        body = 'um Tuesday wait no Friday I mean uh Friday'
        for opening, closing in [('quote', 'unquote'), ('open quote', 'close quote')]:
            words = f'um {opening} {body} {closing} uh'.split()
            start = 1 + len(opening.split())
            end = start + len(body.split())
            with self.subTest(opening=opening):
                result = clean(words)
                self.assertEqual(quoted_text(result['text']), ['Um Tuesday wait no Friday I mean uh Friday.'])
                self.assertFalse(any(edit['kind'] == 'delete' and
                                     edit['at'][0] < end and edit['at'][1] > start
                                     for edit in result['edits']), result)
                self.assertEqual([edit['from'] for edit in result['edits']
                                  if edit['kind'] == 'delete'], ['um', 'uh'])

    def test_tagger_cannot_delete_quoted_fillers_or_repairs(self):
        class Tagger:
            def predict(self, words):
                return [(1, 1.0) if word.lower() in {'um', 'uh', 'wait', 'sorry', 'rather'}
                        else (0, 1.0) for word in words]

        words = 'um open quote um Tuesday wait no Friday sorry rather uh close quote uh'.split()
        result = clean(words, tagger=Tagger())
        self.assertEqual(quoted_text(result['text']), ['Um Tuesday wait no Friday sorry rather uh.'])
        self.assertEqual([edit['at'] for edit in result['edits'] if edit['kind'] == 'delete'],
                         [[0, 1], [13, 14]])

    def test_final_punctuation_is_not_duplicated_after_closing_quote(self):
        for mark in '.?!':
            for opening, closing in [('quote', 'unquote'), ('open quote', 'close quote')]:
                with self.subTest(mark=mark, opening=opening):
                    result = clean(f'{opening} hello{mark} {closing}'.split())
                    self.assertEqual(result['text'], f'“Hello{mark}”')
                    self.assertNotRegex(result['text'], r'[.?!]”[.?!]')

    def test_spoken_final_period_does_not_duplicate_quoted_punctuation(self):
        for source in ['quote hello unquote period',
                       'quote hello. unquote period',
                       'open quote hello close quote period',
                       'open quote hello. close quote period']:
            with self.subTest(source=source):
                self.assertEqual(clean(source.split())['text'], '“Hello.”')

    def test_model_final_punctuation_is_not_duplicated(self):
        class Punctuator:
            def punctuate(self, tokens):
                return [token + '?' if token.lower() == 'hello' else token for token in tokens]

        result = clean('open quote hello close quote'.split(), punctuator=Punctuator())
        self.assertEqual(result['text'], '“Hello?”')

    def test_direct_speech_is_inferred_conservatively(self):
        for source, body in [
            ('she said hello', 'hello'),
            ('he said I will be there', 'I will be there'),
            ('she asked can you fix that', 'can you fix that'),
        ]:
            with self.subTest(source=source):
                result = clean(source.split())
                quoted = quoted_text(result['text'])
                self.assertEqual(len(quoted), 1, result)
                self.assertEqual(quoted[0].rstrip('.?!').lower(), body.lower())
                self.assertNotRegex(result['text'], r'[.?!]”[.?!]')

    def test_inverted_questions_not_indirect_wh_clauses(self):
        for source in ['she asked what time is it', 'she asked why is it broken']:
            self.assertEqual(len(quoted_text(clean(source.split())['text'])), 1)
        for source in ['she asked what time it is', 'she asked why it was broken',
                       'she asked what the issue is']:
            self.assertEqual(quoted_text(clean(source.split())['text']), [])

    def test_indirect_or_ambiguous_speech_is_not_quoted(self):
        for source in [
            'she said that the report was ready',
            'she said she would be there',
            'she asked if you can fix that',
            'she said the report was ready',
        ]:
            with self.subTest(source=source):
                result = clean(source.split())
                self.assertEqual(quoted_text(result['text']), [])
                self.assertEqual(result['text'], source[0].upper() + source[1:] + '.')

    def test_chunk_boundaries_do_not_change_quotation_or_edit_offsets(self):
        for source in [
            'we spoke yesterday. she said quote hello unquote today.',
            'we spoke yesterday. she said open quote hello close quote today.',
            'we spoke yesterday. she asked can you fix that',
            'we spoke yesterday. quote me a price',
        ]:
            words = source.split()
            expected = clean(words)
            for size in (1, 2, 3):
                with self.subTest(source=source, size=size):
                    session = IncrementalCleaner(lookbehind=2)
                    for offset in range(0, len(words), size):
                        session.update(words[offset:offset + size])
                    self.assertEqual(session.finish(), expected)

    def test_long_quotation_is_not_finalized_inside_literal_speech(self):
        body = ('um Tuesday. wait no Friday. I mean uh Friday. ' * 8).strip()
        for opening, closing in [('quote', 'unquote'), ('open quote', 'close quote')]:
            words = f'we spoke yesterday. {opening} {body} {closing} then left.'.split()
            expected = clean(words)
            self.assertEqual(len(quoted_text(expected['text'])), 1)
            self.assertEqual(quoted_text(expected['text'])[0].lower(), body.lower())
            for size in (1, 3, 5):
                with self.subTest(opening=opening, size=size):
                    session = IncrementalCleaner(lookbehind=2)
                    for offset in range(0, len(words), size):
                        session.update(words[offset:offset + size])
                    self.assertEqual(session.finish(), expected)

    def test_fork_inside_long_quoted_passage(self):
        shared = ('we spoke yesterday. open quote ' +
                  'um Tuesday. wait no Friday. I mean uh Friday. ' * 8 + 'I mean uh')
        session = IncrementalCleaner(lookbehind=2)
        words = shared.split()
        for offset in range(0, len(words), 3):
            session.update(words[offset:offset + 3])
        fork = session.fork()
        for cleaner, ending in [(fork, 'Friday close quote'), (session, 'Thursday close quote')]:
            with self.subTest(ending=ending):
                result = cleaner.finish(ending.split())
                self.assertEqual(result, clean(f'{shared} {ending}'.split()))
                self.assertEqual(len(quoted_text(result['text'])), 1)
                self.assertIn('wait no', quoted_text(result['text'])[0].lower())

    def test_fork_preserves_open_quote_without_mutating_original(self):
        for shared in [
            'we spoke yesterday. open',
            'we spoke yesterday. open quote um Tuesday. wait no',
            'we spoke yesterday. quote um Tuesday. wait no',
        ]:
            if shared.endswith('open'):
                first = 'quote um Tuesday wait no Friday close quote'
                second = 'quote um Monday wait no Thursday close quote'
            else:
                closing = 'unquote' if 'yesterday. quote' in shared else 'close quote'
                first = f'Friday {closing}'
                second = f'Thursday {closing}'
            with self.subTest(shared=shared):
                session = IncrementalCleaner(lookbehind=2)
                for word in shared.split():
                    session.update([word])
                fork = session.fork()
                fork_result = fork.finish(first.split())
                original_result = session.finish(second.split())
                self.assertEqual(fork_result, clean(f'{shared} {first}'.split()))
                self.assertEqual(original_result, clean(f'{shared} {second}'.split()))
                self.assertNotEqual(fork_result['text'], original_result['text'])
                self.assertEqual(len(quoted_text(original_result['text'])), 1)


@unittest.skipUnless(os.getenv('PI_STACK_TEST_PUNCTUATION_MODEL'), 'pinned model not supplied')
class PinnedQuotationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from .punctuation import OnnxPunctuator
        cls.model = OnnxPunctuator(Path(os.environ['PI_STACK_TEST_PUNCTUATION_MODEL']))

    def test_direct_and_indirect_speech_with_real_model(self):
        for source, body in [
            ('she said hello', 'hello'),
            ('he said I will be there', 'I will be there'),
            ('she asked can you fix that', 'can you fix that'),
        ]:
            with self.subTest(source=source):
                result = clean(source.split(), punctuator=self.model)
                quoted = quoted_text(result['text'])
                self.assertEqual(len(quoted), 1, result)
                self.assertEqual(re.sub(r'[.,?!]', '', quoted[0]).lower(), body.lower())
                self.assertNotRegex(result['text'], r'[.?!]”[.?!]')
        for source in ['she said that the report was ready', 'she said she would be there',
                       'she asked if you can fix that', 'she said the report was ready']:
            with self.subTest(source=source):
                self.assertEqual(quoted_text(clean(source.split(), punctuator=self.model)['text']), [])

    def test_spoken_controls_and_chunked_fork_with_real_model(self):
        shared = ('we spoke yesterday. open quote ' +
                  'um Tuesday. wait no Friday. I mean uh Friday. ' * 4 + 'I mean uh')
        session = IncrementalCleaner(lookbehind=2, punctuator=self.model)
        words = shared.split()
        for offset in range(0, len(words), 3):
            session.update(words[offset:offset + 3])
        fork = session.fork()
        for cleaner, ending in [(fork, 'Friday close quote'), (session, 'Thursday close quote')]:
            with self.subTest(ending=ending):
                result = cleaner.finish(ending.split())
                self.assertEqual(result, clean(f'{shared} {ending}'.split(), punctuator=self.model))
                quoted = quoted_text(result['text'])
                self.assertEqual(len(quoted), 1, result)
                self.assertIn('um', quoted[0].lower())
                self.assertIn('wait no', quoted[0].lower())
                self.assertIn('I mean', quoted[0])
                self.assertNotRegex(result['text'], r'[.?!]”[.?!]')


if __name__ == '__main__':
    unittest.main()
