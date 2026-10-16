#!/usr/bin/env python3
"""Reclaim only published, ignored integration dependencies with no live consumers."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def run(args):
    result = subprocess.run(args, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {result.stderr.decode(errors="replace").strip()}')
    return result.stdout


def references(proc=Path('/proc')):
    result = []
    for process in proc.iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            for name in ('cwd', 'exe', 'root'):
                try:
                    result.append(os.readlink(process / name).encode())
                except (FileNotFoundError, ProcessLookupError):
                    pass
            for name in ('cmdline', 'environ', 'maps'):
                try:
                    result.append((process / name).read_bytes())
                except (FileNotFoundError, ProcessLookupError):
                    pass
            try:
                for fd in (process / 'fd').iterdir():
                    try:
                        result.append(os.readlink(fd).encode())
                    except (FileNotFoundError, ProcessLookupError):
                        pass
            except (FileNotFoundError, ProcessLookupError):
                pass
        except ProcessLookupError:
            pass
    return result


def candidates(state):
    receipts = [json.loads(p.read_text()) for p in (state / 'requests').glob('*.json')]
    result = []
    integrations = state / 'integrations'
    if not integrations.exists():
        return result
    for root in sorted(integrations.iterdir()):
        target = root / 'node_modules'
        if not re.fullmatch(r'[a-f0-9]{40}', root.name) or root.is_symlink() or not root.is_dir():
            continue
        if not target.is_dir() or target.is_symlink():
            continue
        owners = [receipt for receipt in receipts if receipt.get('integrationSha') == root.name]
        if not owners or any(receipt.get('status') != 'published' for receipt in owners):
            continue
        if run(['git', '-C', str(root), 'ls-files', '--', 'node_modules']).strip():
            raise RuntimeError(f'tracked dependency tree: {target}')
        run(['git', '-C', str(root), 'check-ignore', '-q', 'node_modules'])
        result.append(target)
    return result


def collect(state, execute, census):
    targets = candidates(state)
    live = census()
    results = []
    for target in targets:
        if any(str(target.parent).encode() in reference for reference in live):
            results.append({'path': str(target), 'state': 'referenced'})
            continue
        record = {'path': str(target), 'state': 'eligible'}
        if execute:
            # Reinspect immediately before the mutation; inaccessible processes refuse cleanup.
            if any(str(target.parent).encode() in reference for reference in census()):
                record['state'] = 'referenced'
            else:
                shutil.rmtree(target)
                record['state'] = 'removed'
                with (state / 'dependency-retention.jsonl').open('a') as journal:
                    journal.write(json.dumps(record) + '\n')
                    journal.flush()
                    os.fsync(journal.fileno())
        results.append(record)
    return {'ok': True, 'value': {'execute': execute, 'results': results}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('state', type=Path)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--worker-lock-held', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('all-UID process inspection requires root')
    state = args.state.resolve(strict=True)
    with (state / 'worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if not args.worker_lock_held:
                raise RuntimeError('publication worker is busy')
        else:
            if args.worker_lock_held:
                raise RuntimeError('publication worker custody was not held')
        print(json.dumps(collect(state, args.execute, references)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        print(json.dumps({'ok': False, 'error': {'code': 'integration-retention-failed', 'message': str(error)}}))
        sys.exit(2)
