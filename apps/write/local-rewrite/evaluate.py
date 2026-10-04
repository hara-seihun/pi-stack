"""Fixed diagnostic slice; no training, thresholds, prompts or sampling search."""
import argparse
from dataclasses import asdict
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import statistics
import sys
from time import perf_counter

from runtime import LocalRewriter, MANIFEST

ROOT = Path(__file__).parent
CORPUS = Path('/home/kenan/work/pi-stack-write/cleanup')
DEPLOYED = Path('/srv/pi/write-engine')


def tokens(text):
    return re.findall(r"\w+(?:['’]\w+)*|[^\w\s]", text.lower())


def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j-1] + 1, previous[j-1] + (x != y)))
        previous = current
    return previous[-1]


def freeze():
    rows = []
    sources = {}
    for filename, indices, origin in [
        ('nemotron-public.jsonl', [0, 83, 166], 'real_audio_asr_previous_test_diagnostic'),
        ('disfluency-speech-validation.jsonl', [0, 125], 'verbatim_text_validation_not_asr'),
    ]:
        path = CORPUS / filename
        source = [json.loads(line) for line in path.read_text().splitlines()]
        sources[filename] = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
        for i in indices:
            row = source[i]
            rows.append(dict(id=row['id'], origin=origin, input=row.get('asr', row['raw']),
                             target=row['target'], source_row=i))
    controls = [json.loads(line) for line in (ROOT / 'controls.jsonl').read_text().splitlines()]
    selected = {'authored-negation', 'authored-date-repair', 'authored-exact-identifier',
                'authored-literal-fillers', 'authored-dictionary-names', 'authored-basic'}
    rows.extend(row for row in controls if row['id'] in selected)
    (ROOT / 'slice.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
    (ROOT / 'sources.json').write_text(json.dumps(sources, indent=2) + '\n')
    print('frozen', len(rows), 'rows')


def run(start, count):
    sys.path.insert(0, str(DEPLOYED))
    from cleanup import clean
    from cleanup.tagger import JointOnnxTagger
    from cleanup.punctuation import OnnxPunctuator
    tagger = JointOnnxTagger(DEPLOYED / 'cleanup-model')
    punctuator = OnnxPunctuator(DEPLOYED / 'punctuation-model')
    begin = perf_counter()
    model = LocalRewriter()
    load_ms = (perf_counter() - begin) * 1000
    warmup = model.rewrite('um hello')
    rows = [json.loads(line) for line in (ROOT / 'slice.jsonl').read_text().splitlines()]
    results = []
    for row in rows[start:start+count]:
        begin = perf_counter()
        baseline = clean(row['input'].split(), row.get('dictionary'), tagger=tagger, punctuator=punctuator)['text']
        baseline_ms = (perf_counter() - begin) * 1000
        result = model.rewrite(row['input'])
        gold = tokens(row['target'])
        def measure(text):
            output = tokens(text or '')
            return dict(token_errors=distance(output, gold), gold_tokens=len(gold), exact=output == gold,
                        required_content_pass=all(term.lower() in (text or '').lower() for term in row.get('must_contain', []))
                        and all(term.lower() not in (text or '').lower() for term in row.get('must_not_contain', []))
                        and (not row.get('must_any_contain') or any(term.lower() in (text or '').lower()
                             for term in row['must_any_contain'])))
        receipt = dict(row, baseline=dict(text=baseline, latency_ms=baseline_ms, **measure(baseline)),
                       candidate=dict(**asdict(result), **measure(result.text)))
        results.append(receipt)
        print(row['id'], 'baseline', receipt['baseline']['token_errors'], 'candidate',
              receipt['candidate']['token_errors'], result.error, round(result.latency_ms))
    meta = dict(load_ms=load_ms, warmup=asdict(warmup), deployed_path=str(DEPLOYED.resolve()),
                model=MANIFEST, versions={p:importlib.metadata.version(p) for p in ['onnxruntime','tokenizers','numpy']})
    (ROOT / f'run-{start:02}.json').write_text(json.dumps(dict(meta=meta, rows=results), indent=2) + '\n')


def summarize():
    rows = []
    for path in sorted(ROOT.glob('run-*.json')):
        rows.extend(json.loads(path.read_text())['rows'])
    expected = [json.loads(line)['id'] for line in (ROOT/'slice.jsonl').read_text().splitlines()]
    if sorted(row['id'] for row in rows) != sorted(expected):
        raise SystemExit('missing or duplicate results')
    summary = {}
    for origin in sorted({row['origin'] for row in rows}):
        group = [row for row in rows if row['origin'] == origin]
        summary[origin] = {}
        for method in ['baseline','candidate']:
            vals = [r[method] for r in group]
            latency = sorted(v['latency_ms'] for v in vals)
            summary[origin][method] = dict(n=len(vals), token_errors=sum(v['token_errors'] for v in vals),
                gold_tokens=sum(v['gold_tokens'] for v in vals), exact=sum(v['exact'] for v in vals),
                errors=sum(bool(v.get('error')) for v in vals),
                required_content_pass=sum(v['required_content_pass'] for v in vals) if origin == 'authored' else None,
                latency_p50_ms=statistics.median(latency), latency_p95_ms=latency[math.ceil(.95 * len(latency))-1])
    (ROOT/'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    (ROOT/'results.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['freeze','run','summarize'])
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--count', type=int, default=3)
    args = parser.parse_args()
    if args.action == 'freeze': freeze()
    elif args.action == 'run': run(args.start, args.count)
    else: summarize()
