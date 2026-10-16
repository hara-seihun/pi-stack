import json
import os
import stat
import sys

LIMIT = 32 * 1024 * 1024


def canonical(path):
    return isinstance(path, str) and path.startswith('/') and os.path.normpath(path) == path and '\x00' not in path


def inside(root, path):
    return os.path.commonpath((root, path)) == root


def read_image(path, roots):
    if not canonical(path) or not isinstance(roots, list) or not roots or not all(canonical(root) for root in roots):
        raise ValueError('Image paths and allowed roots must be canonical absolute paths')
    if not any(inside(root, path) for root in roots):
        raise PermissionError('Image path is outside the granted roots')
    real_roots = [os.path.realpath(root) for root in roots]
    if not any(inside(root, os.path.realpath(path)) for root in real_roots):
        raise PermissionError('Image path redirects outside the granted roots')
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
            raise ValueError('Image input must be a regular file of at most 32 MiB')
        actual = os.readlink('/proc/self/fd/' + str(descriptor))
        if actual.endswith(' (deleted)') or not any(inside(root, actual) for root in real_roots):
            raise PermissionError('Opened image moved outside its granted roots')
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65536, LIMIT + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > LIMIT:
                raise ValueError('Image input exceeds 32 MiB')
            chunks.append(chunk)
        return b''.join(chunks)
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Expected image path and granted roots')
        sys.stdout.buffer.write(read_image(sys.argv[1], json.loads(sys.argv[2])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
