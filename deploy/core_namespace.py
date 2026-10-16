"""Fixed trusted namespace handles used by deployment custody and adoption."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

PIN_ROOT = Path('/run/pi-stack/namespaces')


def trusted(path):
    metadata = path.stat()
    if not path.is_file() or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise ValueError('root-owned protected manifest required')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('manifest must be an explicit object')
    return value


def absolute(value):
    if not isinstance(value, str) or not value.startswith('/') or os.path.normpath(value) != value or '\0' in value:
        raise ValueError('canonical absolute path required')
    return Path(value)


def namespace_path(namespace):
    kind = namespace.get('kind')
    if kind == 'host':
        return Path('/proc/1/ns/mnt')
    if kind == 'process':
        pid = namespace['pid']
        if type(pid) is not int or pid < 1 or not isinstance(namespace.get('startTicks'), str) or not re.fullmatch(r'\d+', namespace['startTicks']):
            raise ValueError('invalid process namespace identity')
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        path = Path(f'/proc/{pid}/ns/mnt')
        if fields[19] != namespace['startTicks']:
            raise ValueError('source namespace process changed')
    elif kind == 'pinned':
        path = absolute(namespace['path'])
        if path.parent != PIN_ROOT or not re.fullmatch(r'[a-zA-Z0-9_.-]+', path.name):
            raise ValueError('namespace pin must use the owning runtime directory')
        path = Path('/proc/1/root' + str(path))
        parent = path.parent.stat()
        if parent.st_uid != 0 or parent.st_mode & 0o022 or path.is_symlink():
            raise ValueError('untrusted namespace pin')
    else:
        raise ValueError('explicit namespace kind required')
    inode = namespace.get('mountNamespaceInode')
    if not isinstance(inode, str) or not re.fullmatch(r'\d+', inode) or str(path.stat().st_ino) != inode:
        raise ValueError('mount namespace identity changed')
    filesystem = subprocess.run(['/usr/bin/stat', '-f', '-c', '%t', str(path)], check=True, capture_output=True, text=True, timeout=5).stdout.strip()
    if filesystem != '6e736673':
        raise ValueError('namespace descriptor is not a kernel nsfs handle')
    return path


def enter(namespace, command, uid, gid, timeout=10):
    descriptor = os.open(namespace_path(namespace), os.O_RDONLY)
    try:
        if namespace['kind'] != 'host' and str(os.fstat(descriptor).st_ino) != namespace['mountNamespaceInode']:
            raise ValueError('namespace changed during acquisition')
        return subprocess.run(['/usr/bin/nsenter', f'--mount=/proc/self/fd/{descriptor}', '--',
                               '/usr/bin/setpriv', f'--reuid={uid}', f'--regid={gid}', '--clear-groups', '--', *command],
                              pass_fds=(descriptor,), check=True, capture_output=True, text=True, timeout=timeout).stdout
    finally:
        os.close(descriptor)


def publish(path, value):
    if not path.parent.is_dir():
        raise ValueError('owning manifest directory must already exist')
    fd, temporary = tempfile.mkstemp(prefix='.core-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
