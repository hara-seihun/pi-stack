"""Offline installed-UID regression; no live broker/config/service is changed.

Run as root with BROKER_TEST_BASE pointing at an existing immutable broker release:
python3 deploy/subscription-only-broker_test.py
The test uses a private mount namespace and a fake systemctl for activation.
"""
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


def fixture(root, base, directory):
    directory = Path(directory)
    config = directory / 'config.json'
    config.write_text('{"fixture":"private-config"}')
    config.chmod(0o600)
    systemd = directory / 'systemd'
    systemd.mkdir()
    subprocess.run(['mount', '--bind', str(config), '/etc/pi-model-broker.json'], check=True)
    subprocess.run(['mount', '--bind', str(systemd), '/etc/systemd/system'], check=True)
    commands = directory / 'systemctl-calls'
    binaries = directory / 'bin'
    binaries.mkdir(mode=0o755)
    fake = binaries / 'systemctl'
    fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$BROKER_TEST_CALLS"\n'
                    'case "$*" in *--property=User*|*--property=Group*) echo kenan;; esac\n')
    fake.chmod(0o755)
    # Reproduce both causes: copied code at 0600 and a fresh module emitted under
    # umask 077. The retained dependency links still point at the installed code.
    copied = directory / 'base'
    shutil.copytree(base, copied, symlinks=True)
    for relative in ['dist/auth/subscription-only.js', 'dist/model-broker.js']:
        (copied / relative).chmod(0o600)
    (copied / 'dist/experiment-custody.js').unlink(missing_ok=True)
    dest = directory / 'release'
    env = {**os.environ, 'PATH': f'{binaries}:' + os.environ['PATH'], 'BROKER_TEST_CALLS': str(commands)}
    result = subprocess.run(['bash', str(Path(root) / 'deploy/subscription-only-broker'), str(copied), str(dest), 'pi-model-broker.service'],
                            text=True, capture_output=True, env=env, umask=0o077, timeout=30)
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    receipt = next(json.loads(line) for line in result.stdout.splitlines() if line.startswith('{'))
    assert receipt['uid'] == pwd.getpwnam('kenan').pw_uid, receipt
    assert receipt['networkCalls'] == 0, receipt
    assert stat.S_IMODE(config.stat().st_mode) == 0o640
    assert config.stat().st_uid == 0
    assert config.stat().st_gid == pwd.getpwnam('kenan').pw_gid
    assert json.loads(config.read_text()) == {'fixture': 'private-config'}
    for relative in ['dist/experiment-custody.js', 'dist/model-broker.js', 'dist/auth/subscription-only.js',
                     'src/experiment-custody.ts', 'subscription-only-check.mjs', 'subscription-only-binding.json']:
        assert stat.S_IMODE((dest / relative).stat().st_mode) == 0o644, relative
    assert commands.read_text().splitlines()[-3:] == ['daemon-reload', 'restart pi-model-broker.service', 'is-active --quiet pi-model-broker.service']
    # This is the original regression: the existing offline check must fail as
    # the service identity when a newly imported module becomes unreadable.
    (dest / 'dist/experiment-custody.js').chmod(0o600)
    denied = subprocess.run(['/usr/sbin/runuser', '-u', 'kenan', '--', '/usr/local/bin/node',
                             str(dest / 'subscription-only-check.mjs'), str(dest), str(config)], capture_output=True, text=True)
    assert denied.returncode != 0 and 'EACCES' in denied.stdout + denied.stderr
    print(json.dumps({'runtimeUid': receipt['uid'], 'networkCalls': 0, 'privateConfigMode': '0640', 'unreadableModuleDetected': True}))


class BrokerPublicationPermissions(unittest.TestCase):
    @unittest.skipUnless(os.geteuid() == 0 and os.environ.get('BROKER_TEST_BASE'), 'requires root and BROKER_TEST_BASE; no services are restarted')
    def test_restrictive_umask_and_config_checked_as_runtime_uid(self):
        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory(prefix='broker-permissions-') as directory:
            os.chmod(directory, 0o755)
            subprocess.run(['unshare', '--mount', '--propagation', 'private', sys.executable, str(Path(__file__).resolve()),
                            '--fixture', str(root), os.environ['BROKER_TEST_BASE'], directory], check=True, timeout=45)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--fixture':
        fixture(*sys.argv[2:])
    else:
        unittest.main()
