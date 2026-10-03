#!/usr/bin/env python3
"""Pinned public CPU runtime/model installation; no service or network inference."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[3]
MANIFESTS = Path(__file__).resolve().parent
WRAPPER = '''#!/bin/sh
set -eu
runtime=$(dirname "$(readlink -f "$0")")
export LD_LIBRARY_PATH="$runtime/bin"
exec "$runtime/bin/llama-server" "$@"
'''


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    manifest = json.loads(path.read_text())
    if not re.fullmatch(r'[a-f0-9]{64}', manifest['sha256']):
        raise ValueError('invalid artifact SHA256')
    if not isinstance(manifest['size'], int) or manifest['size'] <= 0:
        raise ValueError('invalid artifact size')
    return manifest


def compatible(manifest):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('Write rewrite requires Linux x86_64')
    libc = os.confstr('CS_GNU_LIBC_VERSION') or ''
    if not libc.startswith('glibc '):
        raise ValueError('Write rewrite requires glibc')
    version = lambda text: tuple(map(int, text.split('.')))
    if version(libc.split()[1]) < version(manifest['minimum_glibc']):
        raise ValueError('Write rewrite requires glibc >= ' + manifest['minimum_glibc'])
    flags = set(Path('/proc/cpuinfo').read_text().split())
    missing = set(manifest['cpu_flags']) - flags
    if missing:
        raise ValueError('Write rewrite CPU missing: ' + ', '.join(sorted(missing)))


def verified(path, manifest):
    return (path.is_file() and not path.is_symlink()
            and path.stat().st_size == manifest['size']
            and digest(path) == manifest['sha256'])


def fetch(manifest, destination, store, cache):
    if verified(destination, manifest):
        return
    candidates = list(store.glob('rewrite-*/*'))
    if cache:
        candidates += list(cache.glob('*'))
    for candidate in candidates:
        if candidate != destination and verified(candidate, manifest):
            shutil.copyfile(candidate, str(destination) + '.part')
            os.replace(str(destination) + '.part', destination)
            return
    subprocess.run(['bash', '-c', 'source "$1"; pi_stack_download_artifact "$2" "$3" "$4"',
                    'download', str(ROOT / 'deploy/lib'), manifest['url'], str(destination),
                    manifest['sha256']], check=True, timeout=45, stdout=sys.stderr)
    if not verified(destination, manifest):
        raise ValueError('artifact size/checksum mismatch: ' + str(destination))


def extract(archive, manifest, destination):
    prefix = manifest['archive_prefix']
    expected = set(manifest['files'])
    if len(expected) != len(manifest['files']) or any(
            not name or PurePosixPath(name).name != name or name in {'.', '..'}
            for name in expected):
        raise ValueError('invalid runtime file allowlist')
    seen = set()
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            path = PurePosixPath(member.filename)
            mode = member.external_attr >> 16
            if (path.is_absolute() or '..' in path.parts or '\\' in member.filename
                    or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                raise ValueError('unsafe archive member: ' + member.filename)
            if member.is_dir():
                continue
            if member.filename in seen:
                raise ValueError('duplicate archive member: ' + member.filename)
            seen.add(member.filename)
            if member.filename not in {prefix + name for name in expected}:
                continue
            if member.file_size > 128 * 1024 * 1024:
                raise ValueError('runtime member too large')
            target = destination / path.name
            with bundle.open(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if path.name == 'llama-server' else 0o644)
    if any(not (destination / name).is_file() for name in expected):
        raise ValueError('runtime archive is incomplete')


def runtime_ready(directory, manifest):
    if not (directory / 'ready').is_file():
        return False
    receipt = json.loads((directory / 'files.json').read_text())
    if set(receipt) != set(manifest['files']):
        return False
    for name, expected in receipt.items():
        path = directory / 'bin' / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            return False
    return ((directory / 'llama-server').read_text() == WRAPPER
            and os.access(directory / 'llama-server', os.X_OK))


def public(directory):
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('symlink in public runtime store: ' + str(path))
        if os.geteuid() == 0:
            os.chown(path, 0, 0)
        path.chmod(0o755 if path.is_dir() or path.name == 'llama-server' else 0o644)
    if os.geteuid() == 0:
        os.chown(directory, 0, 0)
    directory.chmod(0o755)


def install(store, manifests=MANIFESTS, mode='install', cache=None):
    runtime_manifest = manifests / 'runtime.json'
    model_manifest = manifests / 'model.json'
    runtime = load(runtime_manifest)
    model = load(model_manifest)
    license_file = manifests / 'LICENSE-model'
    if model.get('license_sha256') and digest(license_file) != model['license_sha256']:
        raise ValueError('model license checksum mismatch')
    runtime_key = hashlib.sha256(runtime_manifest.read_bytes() + Path(__file__).read_bytes()
                                + (ROOT / 'deploy/write-rewrite-runtime').read_bytes()).hexdigest()
    runtime_dir = store / ('rewrite-runtime-' + runtime_key)
    model_dir = store / ('rewrite-model-' + digest(model_manifest))
    if mode == 'paths':
        return runtime_dir, model_dir
    compatible(runtime)
    if mode == 'check':
        license_ready = (not model.get('license_sha256') or
                         ((model_dir / 'LICENSE').is_file() and
                          digest(model_dir / 'LICENSE') == model['license_sha256']))
        if not runtime_ready(runtime_dir, runtime) or not verified(model_dir / 'model.gguf', model) or not license_ready:
            raise ValueError('Write rewrite runtime/model is missing or corrupt; run deploy/prepare')
    else:
        store.mkdir(parents=True, exist_ok=True, mode=0o755)
        runtime_dir.mkdir(exist_ok=True, mode=0o755)
        model_dir.mkdir(exist_ok=True, mode=0o755)
        if not runtime_ready(runtime_dir, runtime):
            fetch(runtime, runtime_dir / 'artifact.zip', store, cache)
            with tempfile.TemporaryDirectory(prefix='.unpack-', dir=runtime_dir) as staging:
                staged = Path(staging)
                extract(runtime_dir / 'artifact.zip', runtime, staged)
                receipt = {name: digest(staged / name) for name in runtime['files']}
                if (runtime_dir / 'bin').exists():
                    shutil.rmtree(runtime_dir / 'bin')
                os.replace(staged, runtime_dir / 'bin')
            (runtime_dir / 'llama-server').write_text(WRAPPER)
            (runtime_dir / 'files.json').write_text(json.dumps(receipt, sort_keys=True) + '\n')
            shutil.copyfile(runtime_manifest, runtime_dir / 'manifest.json')
            public(runtime_dir)
            subprocess.run([str(runtime_dir / 'llama-server'), '--version'], check=True, timeout=5,
                           stdout=sys.stderr, stderr=sys.stderr)
            (runtime_dir / 'ready').touch(mode=0o644)
        public(runtime_dir)
        fetch(model, model_dir / 'model.gguf', store, cache)
        shutil.copyfile(model_manifest, model_dir / 'manifest.json')
        if model.get('license_sha256'):
            shutil.copyfile(license_file, model_dir / 'LICENSE')
            (model_dir / 'NOTICE').write_text(
                model['attribution'] + '\n'
                'Original model: ' + model['base_model'] + '\n'
                'Base revision: ' + model['base_revision'] + '\n'
                'Quantized weights: ' + model['file'] + '\n'
                'Quantization source: ' + model['quantization_source'] + '\n')
        public(model_dir)
        (model_dir / 'ready').touch(mode=0o644)
    return runtime_dir, model_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('store', type=Path)
    parser.add_argument('--mode', choices=['install', 'check', 'paths'], default='install')
    parser.add_argument('--manifests', type=Path, default=MANIFESTS)
    parser.add_argument('--cache', type=Path)
    args = parser.parse_args()
    try:
        paths = install(args.store.resolve(), args.manifests, args.mode, args.cache)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print('PiStack Write rewrite: ' + str(error), file=sys.stderr)
        return 65
    print('\n'.join(map(str, paths)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
