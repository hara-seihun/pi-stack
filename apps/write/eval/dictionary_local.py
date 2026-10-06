#!/usr/bin/env python3
"""Bounded local CPU before/after replay, sharing one pinned acoustic model.

Burst offline execution is not an end-to-end realtime WebSocket latency test.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

os.environ['OPENBLAS_NUM_THREADS'] = '1'

from evaluate import pcm, score, term_counts

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT.parent / 'engine'


def structure_checks(fixture, final):
    controls = ['open quote', 'close quote']
    expected = term_counts(fixture['verbatim'], controls)
    actual = term_counts(final['raw'], controls)
    protected = ['do not', 'twelve', 'twenty fourth'] if expected['open quote'] else []
    phrases = term_counts(fixture['verbatim'], protected)
    return {'source_quote_controls': all(expected[term] == actual[term] for term in controls),
            'quotation_balance': not expected['open quote'] or (
                final['text'].count('“') == expected['open quote'] and
                final['text'].count('”') == expected['close quote']),
            'quoted_protected_content': all(
                term_counts(final['raw'], [term])[term] == count and
                term_counts(final['text'], [term])[term] == count
                for term, count in phrases.items())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=ROOT / 'manifest.json')
    parser.add_argument('--recognizer-source', type=Path, default=ENGINE / 'nemotron.py')
    parser.add_argument('--label', required=True)
    parser.add_argument('--dictionary', choices=['off', 'on', 'paired'], default='paired')
    parser.add_argument('--model', type=Path, default=Path('/srv/pi/write-engine/model'))
    parser.add_argument('--id', action='append', default=[])
    parser.add_argument('--split', choices=['tune', 'heldout'])
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--limit', type=int, default=1)
    parser.add_argument('--budget', type=float, default=6.0)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    fixtures = [fixture for fixture in manifest['fixtures']
                if (not args.id or fixture['id'] in args.id)
                and (not args.split or fixture.get('split') == args.split)]
    fixtures = fixtures[args.offset:args.offset + args.limit]
    sys.path.insert(0, str(ENGINE))
    spec = importlib.util.spec_from_file_location('selected_recognizer', args.recognizer_source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    import numpy as np
    from nemotron import Nemotron
    from cleanup import IncrementalCleaner
    from cleanup.tagger import JointOnnxTagger
    from cleanup.punctuation import OnnxPunctuator
    model = Nemotron(args.model, threads=4, enable_gpu=False)
    tagger = JointOnnxTagger(Path('/srv/pi/write-engine/cleanup-model'))
    punctuator = OnnxPunctuator(Path('/srv/pi/write-engine/punctuation-model'))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    implementation = {args.recognizer_source.name: hashlib.sha256(args.recognizer_source.read_bytes()).hexdigest()}
    if args.recognizer_source.resolve().parent == ENGINE.resolve():
        implementation.update({name: hashlib.sha256((ENGINE / name).read_bytes()).hexdigest()
                               for name in ['dictionary.py', 'dictionary_decoder.py']})
    with args.output.open('a') as output:
        for fixture in fixtures:
            data = np.frombuffer(pcm(fixture), dtype='<i2').astype(np.float32) / 32768
            for enabled in ([False, True] if args.dictionary == 'paired' else [args.dictionary == 'on']):
                dictionary = manifest['dictionary'] if enabled else {}
                stream = module.Nemotron.create_stream(model, dictionary)
                if hasattr(stream.phrases, 'budget'):
                    stream.phrases.budget = args.budget
                cleaner = IncrementalCleaner(dictionary, tagger=tagger, punctuator=punctuator)
                committed, cleaned_count = [], 0
                began = time.perf_counter()
                for offset in range(0, len(data), 640):
                    stream.accept(data[offset:offset + 640])
                    words = stream.result()['words'][:-2]
                    if [word['w'] for word in words[:len(committed)]] != [word['w'] for word in committed]:
                        raise AssertionError('changed emitted source word')
                    new = words[len(committed):]
                    if new:
                        cleaner.update(new)
                        cleaned_count += len(new)
                    committed = words
                finish_at = time.perf_counter()
                recognized = stream.finish(9600)
                decoded_at = time.perf_counter()
                final = cleaner.finish(recognized['words'][cleaned_count:])
                ended = time.perf_counter()
                result = {'raw': recognized['text'], 'text': final['text']}
                receipt = {'id': fixture['id'], 'label': args.label, 'kind': fixture['kind'],
                           'exposure': fixture['exposure'], 'dictionary_enabled': enabled,
                           'audio_sha256': fixture['sha256'], 'source_sha256': hashlib.sha256(args.recognizer_source.read_bytes()).hexdigest(),
                           'implementation': implementation, 'model_directory': str(args.model.resolve()),
                           'cleanup_sha256': hashlib.sha256((ENGINE / 'cleanup/__init__.py').read_bytes()).hexdigest(),
                           'model_manifest_sha256': hashlib.sha256((ENGINE / 'model.json').read_bytes()).hexdigest(),
                           'mode': 'offline-burst-40ms-600ms-padding', 'budget': args.budget,
                           'raw': result['raw'], 'text': result['text'], 'words': recognized['words'],
                           'metrics': score(fixture, result, enabled, manifest['dictionary']['words']),
                           'structure': structure_checks(fixture, result),
                           'elapsed_ms': round((ended - began) * 1000, 3),
                           'decoder_finish_ms': round((decoded_at - finish_at) * 1000, 3),
                           'finish_ms': round((ended - finish_at) * 1000, 3),
                           'rtf': round((ended - began) / (len(data) / 16000), 4)}
                output.write(json.dumps(receipt) + '\n'); output.flush()
                print(f"{fixture['id']} {enabled}: {result['raw']} -> {result['text']}", flush=True)


if __name__ == '__main__':
    main()
