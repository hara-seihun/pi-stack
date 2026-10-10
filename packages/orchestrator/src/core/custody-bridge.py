#!/usr/bin/python3
"""Fixed namespace resource bridge: filesystem metadata and Unix bytes only."""
import errno
import json
import os
import select
import socket
import stat
import sys


def path(value):
    if not value.startswith('/') or os.path.normpath(value) != value or '\0' in value:
        raise ValueError('Resource path must be canonical and absolute')
    return value


def info(target):
    try:
        value = os.stat(target, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(value.st_mode):
        raise ValueError('Native resource must not redirect to another boundary')
    return {'dev': str(value.st_dev), 'ino': str(value.st_ino), 'mode': value.st_mode}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('socket', 'stat', 'entries'):
        raise ValueError('Expected a fixed resource operation and one path')
    operation, target = sys.argv[1], path(sys.argv[2])
    if operation == 'stat':
        print(json.dumps(info(target)), flush=True)
        return
    if operation == 'entries':
        value = info(target)
        if value is None:
            print('[]', flush=True)
        elif not stat.S_ISDIR(value['mode']):
            raise ValueError('Native generation root is not a directory')
        else:
            print(json.dumps(os.listdir(target)), flush=True)
        return
    value = info(target)
    if value is None or not stat.S_ISSOCK(value['mode']):
        raise ValueError('Native Unix socket is unavailable')
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    peer.connect(target)
    os.write(1, b'{"connected":true}\n')
    try:
        while True:
            ready, _, _ = select.select([0, peer], [], [])
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    return
                peer.sendall(data)
            if peer in ready:
                data = peer.recv(65536)
                if not data:
                    return
                view = memoryview(data)
                while view:
                    view = view[os.write(1, view):]
    finally:
        peer.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error), 'code': errno.errorcode.get(getattr(error, 'errno', None), 'RESOURCE_UNAVAILABLE')}), file=sys.stderr)
        sys.exit(1)
