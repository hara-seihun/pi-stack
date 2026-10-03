#!/usr/bin/env python3
"""Pinned synthetic tuning/heldout controls, declared before first recognition.

Distinct heldout names and near-neighbor sentences are not consulted to select
search settings. This evaluates eSpeak, not natural household pronunciations.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from synthetic import render

ROOT = Path(__file__).resolve().parent
RECIPES = [
    ('tune-hara', 'Hara is ready for the meeting.', ['Hara'], 'tune'),
    ('tune-renia', 'Please use Renia for this document.', ['Renia'], 'tune'),
    ('tune-harry', 'Harry is ready for the meeting.', [], 'tune'),
    ('tune-ready', 'Please be ready for this document.', [], 'tune'),
    ('held-jodie', 'Do not send twelve files to Jodie.', ['Jodie'], 'heldout'),
    ('held-seihun', 'Seihun will arrive on the twenty fourth.', ['Seihun'], 'heldout'),
    ('held-nebulani', 'Use Nebulani for the new project.', ['Nebulani'], 'heldout'),
    ('held-jolly', 'Do not send twelve files to Jolly.', [], 'heldout'),
    ('held-say-when', 'Say when you will arrive on the twenty fourth.', [], 'heldout'),
    ('held-neighbor', 'Ask the neighbor about the new project.', [], 'heldout'),
    ('held-canon', 'Do not send twelve files to Canon.', [], 'heldout'),
    ('held-call-anna', 'Call Anna on the twenty fourth.', [], 'heldout'),
]
WORDS = ['Hara', 'Renia', 'Jodie', 'Seihun', 'Nebulani', 'Kenan', 'Kelana']
FRESH = [
    ('fresh-kenan', 'Please send twelve files to Kenan.', ['Kenan'], 'fresh-heldout'),
    ('fresh-jodie', 'Please send twelve files to Jodie.', ['Jodie'], 'fresh-heldout'),
    ('fresh-qwen', 'Please send twelve files to Qwen.', ['Qwen'], 'fresh-heldout'),
    ('fresh-tailscale', 'Do not disable Tailscale on the twenty fourth.', ['Tailscale'], 'fresh-heldout'),
    ('fresh-canon', 'Please send twelve files to Canon.', [], 'fresh-heldout'),
    ('fresh-call-anna', 'Please call Anna about twelve files.', [], 'fresh-heldout'),
    ('fresh-quinn', 'Please send twelve files to Quinn.', [], 'fresh-heldout'),
    ('fresh-tall-scale', 'Do not remove the tall scale on the twenty fourth.', [], 'fresh-heldout'),
    ('fresh-replacement', 'Please open the letter box.', ['LetterBox'], 'fresh-heldout'),
    ('fresh-replacement-negative', 'Please open the letter and close the window.', [], 'fresh-heldout'),
    ('fresh-quotation', 'He said open quote do not send twelve files to Jodie close quote.', ['Jodie'], 'fresh-heldout'),
]

FINAL = [
    ('final-kenan', 'We should send twelve files to Kenan tomorrow.', ['Kenan'], 'final-heldout'),
    ('final-jodie-quote', 'She said open quote do not send twelve files to Jodie close quote.', ['Jodie'], 'final-heldout'),
    ('final-canon-quote', 'She said open quote do not send twelve files to Canon close quote.', [], 'final-heldout'),
    ('final-anna-quote', 'She said open quote please call Anna tomorrow close quote.', [], 'final-heldout'),
    ('final-replacement-quote', 'She said open quote please open the letter box close quote.', ['LetterBox'], 'final-heldout'),
    ('final-letter-quote', 'She said open quote open the letter and close the window close quote.', [], 'final-heldout'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--fresh-heldout', action='store_true')
    parser.add_argument('--final-heldout', action='store_true')
    args = parser.parse_args()
    recipes = FINAL if args.final_heldout else FRESH if args.fresh_heldout else RECIPES
    heldout = args.fresh_heldout or args.final_heldout
    words = ['Kenan', 'Kelana', 'Jodie', 'Qwen', 'Tailscale', 'LetterBox'] if heldout else WORDS
    replacements = [{'from': 'letter box', 'to': 'LetterBox'}] if heldout else []
    name = 'dictionary-final-heldout.json' if args.final_heldout else 'dictionary-heldout.json' if heldout else 'dictionary-controls.json'
    path = ROOT / name
    existing = json.loads(path.read_text()) if args.check else None
    version = subprocess.run(['espeak-ng', '--version'], capture_output=True, text=True, check=True, timeout=5).stdout.splitlines()[0]
    fixtures = []
    for identifier, text, expected, split in recipes:
        audio = render(text)
        digest = hashlib.sha256(audio).hexdigest()
        if args.check:
            fixture = next(item for item in existing['fixtures'] if item['id'] == identifier)
            if fixture['sha256'] != digest:
                raise ValueError(f'{identifier}: pinned synthesis changed')
        else:
            relative = f'audio/{identifier}.wav'
            (ROOT / relative).write_bytes(audio)
            fixtures.append({'id': identifier, 'audio': relative, 'sha256': digest,
                             'kind': 'synthetic-espeak', 'license': 'CC0-1.0',
                             'exposure': split + '-synthetic-declared-before-recognition', 'split': split,
                             'source': {'generator': version, 'voice': 'en-gb', 'speed': 155, 'text': text},
                             'verbatim': text, 'target': text, 'expected_terms': expected,
                             'expectation': 'strict',
                             'tags': ['synthetic', 'dictionary-positive' if expected else 'dictionary-negative'],
                             'meaning': {'required': [[text.rstrip('.')]], 'forbidden': []}})
            if identifier == 'fresh-replacement':
                fixtures[-1]['dictionary_target'] = 'Please open the LetterBox.'
                fixtures[-1]['meaning']['required'] = [['please open'], ['letter box', 'LetterBox']]
            if identifier == 'fresh-quotation':
                fixtures[-1]['target'] = 'He said “do not send twelve files to Jodie.”'
                fixtures[-1]['meaning']['required'] = [['do not send twelve files to Jodie']]
            if identifier.startswith('final-') and 'open quote ' in text:
                intro, quoted = text.split('open quote ', 1)
                quoted = quoted.removesuffix(' close quote.')
                fixtures[-1]['target'] = intro.strip() + ' “' + quoted[0].upper() + quoted[1:] + '.”'
                fixtures[-1]['meaning']['required'] = [[quoted]]
                if identifier == 'final-replacement-quote':
                    fixtures[-1]['dictionary_target'] = fixtures[-1]['target'].replace('letter box', 'LetterBox')
                    fixtures[-1]['meaning']['required'] = [['please open'], ['letter box', 'LetterBox']]
    if not args.check:
        path.write_text(json.dumps({'version': 1, 'fixtures': fixtures,
                                    'dictionary': {'words': words, 'replacements': replacements}}, indent=2) + '\n')
    print(f'{len(recipes)} explicitly synthetic clips {"checked" if args.check else "generated"}')


if __name__ == '__main__':
    main()
