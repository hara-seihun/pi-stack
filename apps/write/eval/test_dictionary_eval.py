import json
from pathlib import Path
import unittest

from dictionary_local import structure_checks

ROOT = Path(__file__).resolve().parent


class DictionaryEvaluationTest(unittest.TestCase):
    def test_quote_control_loss_is_not_a_meaning_proxy_pass(self):
        fixture = {'verbatim': 'He said open quote do not send twelve files close quote.'}
        good = {'raw': fixture['verbatim'], 'text': 'He said “Do not send twelve files.”'}
        self.assertTrue(all(structure_checks(fixture, good).values()))
        bad = {'raw': good['raw'].replace(' close quote', ''), 'text': 'He said “Do not send twelve files.'}
        self.assertFalse(structure_checks(fixture, bad)['source_quote_controls'])
        self.assertFalse(structure_checks(fixture, bad)['quotation_balance'])
        bad = {'raw': good['raw'], 'text': 'He said “Send files.”'}
        self.assertFalse(structure_checks(fixture, bad)['quoted_protected_content'])

    def test_final_corpus_has_one_plain_dictionary_pair_per_fixture(self):
        for filename, manifest_name in [('corpus-before.jsonl', 'dictionary-results/corpus-manifest.json'),
                                        ('final-safe-corpus.jsonl', 'dictionary-results/corpus-manifest.json'),
                                        ('final-heldout-before.jsonl', 'dictionary-final-heldout.json'),
                                        ('final-heldout-after.jsonl', 'dictionary-final-heldout.json')]:
            fixtures = json.loads((ROOT / manifest_name).read_text())['fixtures']
            expected = {(fixture['id'], enabled) for fixture in fixtures for enabled in [False, True]}
            receipts = [json.loads(line) for line in (ROOT / 'dictionary-results' / filename).read_text().splitlines()]
            actual = [(receipt['id'], receipt['dictionary_enabled']) for receipt in receipts]
            self.assertEqual(set(actual), expected)
            self.assertEqual(len(actual), len(expected))
            by_id = {fixture['id']: fixture for fixture in fixtures}
            for receipt in receipts:
                self.assertEqual(receipt['audio_sha256'], by_id[receipt['id']]['sha256'])

    def test_frozen_final_holdout_keeps_quote_negation_and_number_controls(self):
        manifest = json.loads((ROOT / 'dictionary-final-heldout.json').read_text())
        fixtures = {fixture['id']: fixture for fixture in manifest['fixtures']}
        receipts = [json.loads(line) for line in (ROOT / 'dictionary-results/final-heldout-after.jsonl').read_text().splitlines()]
        implementations = {json.dumps(receipt['implementation'], sort_keys=True) for receipt in receipts}
        self.assertEqual(len(implementations), 1)
        for receipt in receipts:
            self.assertTrue(all(structure_checks(fixtures[receipt['id']], receipt).values()))
            self.assertEqual(receipt['metrics']['dictionary']['clean']['fp'], 0)
            if receipt['dictionary_enabled']:
                self.assertTrue(receipt['metrics']['formatted_exact'])


if __name__ == '__main__':
    unittest.main()
