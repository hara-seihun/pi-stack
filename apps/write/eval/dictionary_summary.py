#!/usr/bin/env python3
"""Summarize immutable lexical-search receipts without rerunning recognition."""
from collections import defaultdict
import json
from pathlib import Path
import statistics

from dictionary_local import structure_checks

ROOT = Path(__file__).resolve().parent
SOURCES = [
    ('corpus-before.jsonl', 'manifest.json', 'before'),
    ('final-safe-corpus.jsonl', 'manifest.json', 'final'),
    ('fresh-heldout-before.jsonl', 'dictionary-heldout.json', 'before-first-holdout'),
    ('fresh-heldout-after.jsonl', 'dictionary-heldout.json', 'failed-first-holdout'),
    ('quote-repair.jsonl', 'dictionary-heldout.json', 'quote-repair-diagnostic'),
    ('final-heldout-before.jsonl', 'dictionary-final-heldout.json', 'before-final-holdout'),
    ('final-heldout-after.jsonl', 'dictionary-final-heldout.json', 'final-holdout'),
]


def main():
    groups = defaultdict(list)
    for filename, manifest_name, label in SOURCES:
        manifest = json.loads((ROOT / manifest_name).read_text())
        fixtures = {fixture['id']: fixture for fixture in manifest['fixtures']}
        seen = set()
        for line in (ROOT / 'dictionary-results' / filename).read_text().splitlines():
            receipt = json.loads(line)
            key = (receipt['id'], receipt['dictionary_enabled'])
            if key in seen:
                raise ValueError(f'duplicate measurement: {filename}/{key}')
            seen.add(key)
            receipt['structure'] = structure_checks(fixtures[receipt['id']], receipt)
            groups[(label, receipt['kind'], receipt['dictionary_enabled'])].append(receipt)
    result = []
    for (label, kind, enabled), receipts in groups.items():
        row = {'label': label, 'kind': kind, 'dictionary_enabled': enabled, 'sessions': len(receipts)}
        row['dictionary'] = {}
        for channel in ['raw', 'clean']:
            counts = {count: sum(receipt['metrics']['dictionary'][channel][count] for receipt in receipts)
                      for count in ['tp', 'fp', 'fn']}
            counts['precision'] = counts['tp'] / (counts['tp'] + counts['fp']) if counts['tp'] + counts['fp'] else None
            counts['recall'] = counts['tp'] / (counts['tp'] + counts['fn']) if counts['tp'] + counts['fn'] else None
            row['dictionary'][channel] = counts
        for metric in ['raw_verbatim', 'raw_target', 'clean_target']:
            errors = sum(receipt['metrics'][metric]['errors'] for receipt in receipts)
            words = sum(receipt['metrics'][metric]['reference_words'] for receipt in receipts)
            row[metric] = {'errors': errors, 'reference_words': words, 'wer': errors / words}
        row['expectations_passed'] = sum(receipt['metrics']['expectation_pass'] for receipt in receipts)
        row['structure_failed'] = [receipt['id'] for receipt in receipts if not all(receipt['structure'].values())]
        for metric in ['elapsed_ms', 'decoder_finish_ms', 'finish_ms', 'rtf']:
            values = sorted(receipt[metric] for receipt in receipts)
            row[metric] = {'median': statistics.median(values), 'max': max(values)}
        result.append(row)
    output = ROOT / 'dictionary-results/summary.json'
    output.write_text(json.dumps(result, indent=2) + '\n')
    for row in result:
        print(row['label'], row['kind'], row['dictionary_enabled'], row['sessions'],
              row['dictionary']['clean'], 'rawWER', round(row['raw_verbatim']['wer'] * 100, 2),
              'cleanWER', round(row['clean_target']['wer'] * 100, 2), 'structure failures', row['structure_failed'])


if __name__ == '__main__':
    main()
