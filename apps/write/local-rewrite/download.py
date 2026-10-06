"""Rebuild the pinned cache, one selected artifact per bounded command."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

MANIFEST = json.loads(Path(__file__).with_name('model.json').read_text())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('file', choices=list(MANIFEST['files']))
    args = parser.parse_args()
    target = Path(MANIFEST['cache']) / args.file
    expected = MANIFEST['files'][args.file]
    if target.exists() and hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == expected:
        print('verified', target)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + '.partial')
    url = f"https://huggingface.co/{MANIFEST['repo']}/resolve/{MANIFEST['revision']}/{args.file}"
    digest = hashlib.sha256()
    with urlopen(url, timeout=35) as response, partial.open('wb') as out:
        while chunk := response.read(1024 * 1024):
            out.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != expected:
        partial.unlink()
        raise SystemExit('download SHA256 mismatch')
    partial.replace(target)
    print('verified', target, target.stat().st_size)


if __name__ == '__main__':
    main()
