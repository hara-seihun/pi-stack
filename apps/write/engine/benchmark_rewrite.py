"""Bounded entirely-local rewrite benchmark; authored text is not acoustic proof."""
import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

from cleanup import clean, dictionary_text
from cleanup.punctuation import OnnxPunctuator
from cleanup.tagger import JointOnnxTagger
from rewrite import LocalRewriter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'eval'))
from evaluate import distance, tokens


def word_error(reference, hypothesis):
    return {'errors': distance(tokens(reference), tokens(hypothesis)),
            'reference_words': len(tokens(reference))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--count', type=int, default=4)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.start < 0 or not 1 <= args.count <= 20:
        parser.error('start >= 0 and count in [1,20] required')
    cases = json.loads(Path(__file__).with_name('rewrite-cases.json').read_text())[args.start:args.start + args.count]
    tagger = JointOnnxTagger(Path('/srv/pi/write-engine/cleanup-model'))
    punctuator = OnnxPunctuator(Path('/srv/pi/write-engine/punctuation-model'))
    rows = []
    rewriter = LocalRewriter(args.binary, args.model)
    try:
        for case in cases:
            dictionary = case.get('dictionary', {})
            words = case['source'].split()
            baseline = clean(words, dictionary, tagger=tagger, punctuator=punctuator)['text']
            decision = rewriter.rewrite(dictionary_text(words, dictionary), baseline, dictionary)
            def normalized(text):
                text = text.casefold().replace('’', "'")
                for old, new in [("i'm", 'i am'), ("it's", 'it is'), ("don't", 'do not')]:
                    text = text.replace(old, new)
                return text
            def passed(text):
                return (all(normalized(word) in normalized(text) for word in case['keep']) and
                        all(normalized(word) not in normalized(text) for word in case['forbid']))
            row = dict(case, baseline=baseline, decision=asdict(decision),
                       baseline_pass=passed(baseline), rewrite_pass=passed(decision.text),
                       baseline_wer=word_error(case['target'], baseline),
                       rewrite_wer=word_error(case['target'], decision.text))
            rows.append(row)
            print(json.dumps(row), flush=True)
    finally:
        rewriter.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(''.join(json.dumps(row) + '\n' for row in rows))
    def digest(path):
        with path.open('rb') as file:
            return hashlib.file_digest(file, 'sha256').hexdigest()
    owner = Path(__file__).resolve().parent
    metadata = {'measuredAt': datetime.now(timezone.utc).isoformat(), 'threads': 4,
                'modelSha256': digest(args.model), 'runtimeExecutableSha256': digest(args.binary),
                'sources': {str(path.relative_to(owner)): digest(path) for path in
                            (owner/'rewrite.py', owner/'cleanup/__init__.py', owner/'rewrite-cases.json',
                             owner/'benchmark_rewrite.py', owner/'cleanup/model.json', owner/'punctuation-model.json')},
                'caseIds': [row['id'] for row in rows]}
    args.output.with_suffix('.metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')


if __name__ == '__main__':
    main()
