"""Evaluate final editing of recorded public ASR receipts, not fresh recognition."""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys

from cleanup import clean, dictionary_text
from cleanup.punctuation import OnnxPunctuator
from cleanup.tagger import JointOnnxTagger
from rewrite import LocalRewriter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'eval'))
from evaluate import load_manifest, score


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--receipts', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dictionary', choices=['on', 'off'], default='on')
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--limit', type=int, default=13)
    args = parser.parse_args()
    if args.offset < 0 or not 1 <= args.limit <= 13:
        parser.error('offset >= 0 and limit in [1,13] required')
    enabled = args.dictionary == 'on'
    manifest = load_manifest()
    fixtures = {f['id']: f for f in manifest['fixtures'] if f['kind'] == 'natural-meeting'}
    records = [json.loads(line) for line in args.receipts.read_text().splitlines()]
    selected = [r for r in records if r['id'] in fixtures and r['dictionary_enabled'] == enabled]
    if len({r['id'] for r in selected}) != len(selected):
        raise ValueError('Duplicate recognition receipts require an explicit selection')
    selected = selected[args.offset:args.offset + args.limit]
    tagger = JointOnnxTagger(Path('/srv/pi/write-engine/cleanup-model'))
    punctuator = OnnxPunctuator(Path('/srv/pi/write-engine/punctuation-model'))
    rewriter = LocalRewriter(args.binary, args.model)
    dictionary = manifest['dictionary'] if enabled else {}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with args.output.open('w') as output:
            for record in selected:
                fixture = fixtures[record['id']]
                if record['audio_sha256'] != fixture['sha256']:
                    raise ValueError('Recognition receipt does not match committed audio')
                baseline = clean(record['words'], dictionary, tagger=tagger, punctuator=punctuator)['text']
                source = dictionary_text(record['words'], dictionary)
                decision = rewriter.rewrite(source, baseline, dictionary)
                def metrics(text):
                    return score(fixture, {'raw': record['raw'], 'text': text}, enabled, manifest['dictionary']['words'])
                row = {'id': record['id'], 'mode': 'editing-recorded-real-ASR-not-fresh-recognition',
                       'recognition': record, 'baseline': baseline, 'decision': asdict(decision),
                       'baseline_metrics': metrics(baseline), 'rewrite_metrics': metrics(decision.text)}
                output.write(json.dumps(row) + '\n'); output.flush()
                print(record['id'], decision.status, decision.text, flush=True)
    finally:
        rewriter.close()
    def digest(path):
        with path.open('rb') as file:
            return hashlib.file_digest(file, 'sha256').hexdigest()
    owner = Path(__file__).resolve().parent
    metadata = {'mode': 'editing-recorded-real-ASR-not-fresh-recognition',
                'recognitionReceiptsSha256': digest(args.receipts), 'modelSha256': digest(args.model),
                'sources': {str(path.relative_to(owner)): digest(path) for path in
                            (owner/'rewrite.py', owner/'cleanup/__init__.py', owner/'cleanup/punctuation.py',
                             owner/'benchmark_rewrite_audio.py')},
                'manifestSha256': digest(owner.parent/'eval/manifest.json'),
                'caseIds': [r['id'] for r in selected]}
    args.output.with_suffix('.metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')


if __name__ == '__main__':
    main()
