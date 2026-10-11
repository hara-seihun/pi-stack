#!/usr/bin/env python3
"""Materialize reciprocal enrolled transport resources; publication owns activation."""
import argparse
import json
import os
from pathlib import Path
import shlex
import socket
import stat
from urllib.parse import urlsplit


def reciprocal_tunnel_command(unit: str, port: int) -> str:
    commands = [line.split('=', 1)[1] for line in unit.splitlines() if line.startswith('ExecStart=') and line != 'ExecStart=']
    if len(commands) != 1:
        raise ValueError('Existing tunnel must have one explicit ExecStart')
    args = shlex.split(commands[0])
    if not args or args[0] != '/usr/bin/ssh' or '-NT' not in args or '-R' not in args or '-L' in args:
        raise ValueError('Expected original SSH reverse policy tunnel, without another local forward')
    args[-1:-1] = ['-L', f'127.0.0.1:{port}:127.0.0.1:{port}']
    return shlex.join(args)


def protected(path: Path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != 0o600 or s.st_size > 65536:
        raise ValueError('Root-owned0600 bounded enrollment required')
    return json.loads(path.read_text())


def publish(path: Path, body: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.is_symlink() or path.read_text() != body:
            raise ValueError(f'Resource differs from this enrolled intent: {path}')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, 'w') as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', required=True)
    parser.add_argument('--artifact', required=True, help='Published absolute core-manager-policy-forward.mjs path')
    args = parser.parse_args()
    if os.geteuid() != 0 or not args.binding or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-' for c in args.binding):
        raise ValueError('Host owner and exact enrollment identity required')
    directory = Path('/etc/pi-stack/manager-policy') / args.binding
    binding = protected(directory / 'binding.json')
    capability = protected(directory / 'context.json')
    store = protected(Path('/etc/pi-stack/canonical-manager-policy.json'))
    if capability.get('purpose') != 'canonical-work-context' or capability.get('version') != 1 or capability.get('binding') != binding or [row for row in store['bindings'] if row['id'] == args.binding] != [binding]:
        raise ValueError('Exact current same-identity work-context enrollment required')
    origin = urlsplit(capability['sourceOrigin'])
    if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or not origin.port or origin.path or origin.query or origin.fragment or origin.username or origin.password:
        raise ValueError('Explicit reciprocal loopback origin required')
    port = origin.port
    artifact = Path(args.artifact)
    if not artifact.is_absolute() or not artifact.is_file() or artifact.name != 'core-manager-policy-forward.mjs' or any(ord(c) < 32 for c in str(artifact)):
        raise ValueError('Published source-owned forward artifact required')
    if binding['direction'] == 'outgoing' and binding['source']['host'] == socket.gethostname():
        path = Path('/etc/systemd/system/pi-stack-manager-context-forward.service')
        body = '[Unit]\nDescription=Enrolled same-person work-context loopback transport\nAfter=network.target\n\n[Service]\nType=simple\n'
        body += f'ExecStart=/usr/local/bin/bun {shlex.quote(str(artifact))} {port}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\n\n[Install]\nWantedBy=multi-user.target\n'
    elif binding['direction'] == 'incoming' and binding['target']['host'] == socket.gethostname():
        original = Path('/etc/systemd/system/pi-stack-manager-policy-tunnel.service').read_text()
        path = Path('/etc/systemd/system/pi-stack-manager-policy-tunnel.service.d/work-context.conf')
        body = '[Service]\nExecStart=\nExecStart=' + reciprocal_tunnel_command(original, port) + '\n'
    else:
        raise ValueError('Enrollment does not name this host and direction')
    publish(path, body)
    print(json.dumps({'state': 'transport-resources-prepared', 'bindingId': args.binding, 'resource': str(path), 'port': port, 'runtimeLifecycle': False, 'credentialChanged': False, 'uiGrantsChanged': False}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'state': 'refused', 'message': str(error)}))
        raise SystemExit(1)
